using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class NewmarkProcessSnapshot
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const int ERROR_INVALID_PARAMETER = 87;
    private const string PROCESS_ABSENT = "-";
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    private static string CreationIdentity(uint pid)
    {
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_INVALID_PARAMETER) return PROCESS_ABSENT;
            throw new System.ComponentModel.Win32Exception(error);
        }
        try
        {
            FILETIME creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_INVALID_PARAMETER) return PROCESS_ABSENT;
                throw new System.ComponentModel.Win32Exception(error);
            }
            ulong value = ((ulong)creation.High << 32) | creation.Low;
            return value.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }
        finally
        {
            CloseHandle(process);
        }
    }

    public static string Capture(
        uint rootPid,
        string encodedAnchors,
        string barrierReadyBase64,
        string barrierContinueBase64)
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            var processes = new List<Tuple<uint, uint>>();
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (Process32FirstW(snapshot, ref entry))
            {
                do
                {
                    processes.Add(Tuple.Create(entry.th32ProcessID, entry.th32ParentProcessID));
                }
                while (Process32NextW(snapshot, ref entry));
            }

            var livePids = new HashSet<uint>();
            foreach (var process in processes) livePids.Add(process.Item1);
            if (!String.IsNullOrEmpty(barrierReadyBase64) && !String.IsNullOrEmpty(barrierContinueBase64))
            {
                string readyPath = Encoding.UTF8.GetString(Convert.FromBase64String(barrierReadyBase64));
                string continuePath = Encoding.UTF8.GetString(Convert.FromBase64String(barrierContinueBase64));
                File.WriteAllText(readyPath, "ready");
                DateTime deadline = DateTime.UtcNow.AddSeconds(8);
                while (!File.Exists(continuePath))
                {
                    if (DateTime.UtcNow >= deadline)
                        throw new TimeoutException("Windows process snapshot test barrier timed out");
                    Thread.Sleep(10);
                }
            }

            var owned = new HashSet<uint>();
            var parentOnlyWitnesses = new HashSet<uint>();
            var verifiedIdentities = new Dictionary<uint, string>();
            bool rootHasBoundIdentity = false;
            foreach (string encoded in encodedAnchors.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = encoded.Split(':');
                uint anchorPid = UInt32.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture);
                if (parts.Length < 2 || String.IsNullOrEmpty(parts[1]))
                {
                    owned.Add(anchorPid);
                    continue;
                }
                if (anchorPid == rootPid) rootHasBoundIdentity = true;
                ulong expectedCreation;
                if (!UInt64.TryParse(parts[1], out expectedCreation)) continue;
                if (!livePids.Contains(anchorPid))
                {
                    // Preserve the old PID as a parent-only witness. Toolhelp keeps a
                    // child's original parent PID after the parent exits, so this lets a
                    // late orphan surface and fail closed in the JS identity merge.
                    owned.Add(anchorPid);
                    parentOnlyWitnesses.Add(anchorPid);
                    continue;
                }
                string actualCreationText = CreationIdentity(anchorPid);
                if (actualCreationText == PROCESS_ABSENT)
                {
                    // Toolhelp is a point-in-time list. The anchor may exit after that
                    // list is captured but before OpenProcess; retain only its old PID as
                    // a parent witness and never output or terminate a replacement.
                    owned.Add(anchorPid);
                    parentOnlyWitnesses.Add(anchorPid);
                    continue;
                }
                ulong actualCreation;
                if (!UInt64.TryParse(actualCreationText, out actualCreation))
                    throw new InvalidOperationException("Could not verify a Windows anchor creation identity");
                if (actualCreation == expectedCreation)
                {
                    owned.Add(anchorPid);
                    verifiedIdentities[anchorPid] = actualCreationText;
                    continue;
                }

                // The PID now belongs to another process. Never seed that replacement
                // or its new children. A direct child that predates the replacement can
                // only be an orphan from an earlier PID owner; seed just that candidate
                // so the JS merge can quarantine an unprovable late descendant.
                foreach (var process in processes)
                {
                    if (process.Item2 != anchorPid) continue;
                    string childCreationText = CreationIdentity(process.Item1);
                    if (childCreationText == PROCESS_ABSENT) continue;
                    ulong childCreation;
                    if (!UInt64.TryParse(childCreationText, out childCreation))
                        throw new InvalidOperationException("Could not verify a Windows child creation identity");
                    if (childCreation >= expectedCreation && childCreation < actualCreation)
                    {
                        owned.Add(process.Item1);
                        verifiedIdentities[process.Item1] = childCreationText;
                    }
                }
            }

            // The initial snapshot has no bound anchors and must discover the root.
            // Rescans pass the captured root identity, so a reused root PID is never
            // adopted as a member of the old runtime tree.
            if (!rootHasBoundIdentity) owned.Add(rootPid);
            bool changed;
            do
            {
                changed = false;
                foreach (var process in processes)
                {
                    if (!owned.Contains(process.Item2) || owned.Contains(process.Item1)) continue;
                    owned.Add(process.Item1);
                    changed = true;
                }
            }
            while (changed);

            var rows = new List<string>();
            foreach (var process in processes)
            {
                if (!owned.Contains(process.Item1)) continue;
                if (parentOnlyWitnesses.Contains(process.Item1)) continue;
                string creationIdentity;
                if (!verifiedIdentities.TryGetValue(process.Item1, out creationIdentity))
                    creationIdentity = CreationIdentity(process.Item1);
                if (creationIdentity == PROCESS_ABSENT) continue;
                ulong parsedCreationIdentity;
                if (!UInt64.TryParse(creationIdentity, out parsedCreationIdentity))
                    throw new InvalidOperationException("Could not verify an owned Windows process creation identity");
                rows.Add(process.Item1.ToString() + "," + process.Item2.ToString() + "," + creationIdentity);
            }
            return string.Join("\n", rows);
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }
}

public static class NewmarkIdentityTerminator
{
    private const uint PROCESS_TERMINATE = 0x00000001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const int ERROR_INVALID_PARAMETER = 87;

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private sealed class Target
    {
        public IntPtr Handle;
        public uint Pid;
    }

    public static string KillAll(string encodedTargets)
    {
        var targets = new List<Target>();
        try
        {
            foreach (string encoded in encodedTargets.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                string[] parts = encoded.Split(':');
                uint pid = UInt32.Parse(parts[0], System.Globalization.CultureInfo.InvariantCulture);
                ulong expectedCreation = UInt64.Parse(parts[1], System.Globalization.CultureInfo.InvariantCulture);
                IntPtr process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
                if (process == IntPtr.Zero)
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ERROR_INVALID_PARAMETER) continue;
                    throw new System.ComponentModel.Win32Exception(error);
                }
                FILETIME creation, exit, kernel, user;
                if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
                {
                    CloseHandle(process);
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                }
                ulong actualCreation = ((ulong)creation.High << 32) | creation.Low;
                if (actualCreation != expectedCreation)
                {
                    CloseHandle(process);
                    throw new InvalidOperationException("PID creation identity changed; refusing to terminate a reused PID");
                }
                targets.Add(new Target { Handle = process, Pid = pid });
            }
            foreach (Target target in targets)
            {
                if (!TerminateProcess(target.Handle, 1))
                    throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            }
            return "terminated:" + targets.Count.ToString();
        }
        finally
        {
            foreach (Target target in targets) CloseHandle(target.Handle);
        }
    }
}
