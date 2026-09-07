/** Linux termination uses pidfds, never a bare PID/PGID signal. */
export interface WslRuntimeProcessIdentity {
  pid: number;
  pgid: number;
  sessionId: number;
  startTimeTicks: string;
  bootId: string;
}

export function wslRuntimeProcessTreeCommand(identity: WslRuntimeProcessIdentity): string {
  const script = `import os,sys,json,signal,time,select
expected=json.loads(${JSON.stringify(JSON.stringify(identity))})
owned={}
complete=False
capture_deadline=time.monotonic()+2.0
def interrupted(signum,frame): raise RuntimeError('termination helper interrupted before ownership cleanup completed')
for signum in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT,signal.SIGALRM): signal.signal(signum,interrupted)
signal.setitimer(signal.ITIMER_REAL,3.5)
def fail(message): raise RuntimeError(message)
def stat(pid):
    try:
        raw=open('/proc/'+str(pid)+'/stat').read()
    except FileNotFoundError: return None
    fields=raw[raw.rfind(')')+2:].split()
    return {'pid':pid,'parentPid':int(fields[1]),'pgid':int(fields[2]),'sessionId':int(fields[3]),'startTimeTicks':fields[19],'state':fields[0]}
def same(a,b): return a is not None and a['pid']==b['pid'] and a['startTimeTicks']==b['startTimeTicks']
def exited(fd): return bool(select.select([fd],[],[],0)[0])
def hold(entry,depth):
    before=stat(entry['pid'])
    if not same(before,entry): fail('process identity changed before pidfd capture')
    fd=os.pidfd_open(entry['pid'],0)
    after=stat(entry['pid'])
    if not same(after,entry):
        os.close(fd)
        fail('process identity changed while opening pidfd')
    owned[entry['pid']]={'entry':entry,'fd':fd,'depth':depth}
    if exited(fd): fail('owned process exited before descendant capture; tree is unconfirmed')
    signal.pidfd_send_signal(fd,signal.SIGSTOP,None,0)
    deadline=min(capture_deadline,time.monotonic()+0.4)
    while time.monotonic()<deadline:
        current=stat(entry['pid'])
        if exited(fd) or not same(current,entry): fail('owned process exited during descendant capture; tree is unconfirmed')
        if current['state'] in ('T','t'): return
        time.sleep(0.005)
    fail('owned process could not be paused; descendant tree is unconfirmed')
try:
    if not hasattr(os,'pidfd_open') or not hasattr(signal,'pidfd_send_signal'):
        fail('Python 3 with Linux pidfd_open/pidfd_send_signal is required; refusing numeric PID fallback')
    boot=open('/proc/sys/kernel/random/boot_id').read().strip().lower()
    if boot!=expected['bootId']: fail('runtime boot identity mismatch; refusing stale tree signal')
    leader=stat(expected['pid'])
    if leader is None: fail('original runtime leader is absent; descendant ownership is unconfirmed')
    if not same(leader,expected) or leader['pgid']!=expected['pgid'] or leader['sessionId']!=expected['sessionId']:
        fail('runtime identity mismatch; refusing stale tree signal')
    hold(leader,0)
    while True:
        if time.monotonic()>capture_deadline: fail('descendant capture deadline exceeded')
        current={}
        for name in os.listdir('/proc'):
            if time.monotonic()>capture_deadline: fail('descendant scan deadline exceeded')
            if name.isdigit():
                row=stat(int(name))
                if row is not None: current[row['pid']]=row
        added=False
        for pid,item in list(owned.items()):
            if exited(item['fd']) or not same(current.get(pid),item['entry']):
                fail('known ancestor exited before tree capture completed')
        for row in current.values():
            if time.monotonic()>capture_deadline: fail('descendant scan deadline exceeded')
            if row['pid'] in owned: continue
            parent=owned.get(row['parentPid'])
            if parent is None: continue
            if not same(current.get(row['parentPid']),parent['entry']): fail('parent identity changed')
            if int(row['startTimeTicks'])<int(parent['entry']['startTimeTicks']): fail('child predates claimed parent')
            if len(owned)>=1024: fail('owned descendant limit exceeded')
            hold(row,parent['depth']+1)
            added=True
        if not added: break
    # Every proven ancestor is paused, so no new child can escape the final scan.
    # pidfd_send_signal keeps the kernel process identity even if its number is
    # recycled after these checks; no process.kill/killpg fallback is permitted.
    for item in sorted(owned.values(),key=lambda x:x['depth'],reverse=True):
        try: signal.pidfd_send_signal(item['fd'],signal.SIGKILL,None,0)
        except ProcessLookupError: pass
    deadline=time.monotonic()+1.2
    while time.monotonic()<deadline and any(not exited(item['fd']) for item in owned.values()): time.sleep(0.01)
    if any(not exited(item['fd']) for item in owned.values()): fail('owned pidfd termination remains unconfirmed')
    complete=True
    print(json.dumps({'terminated':True,'method':'pidfd_tree','rootPid':expected['pid'],'entries':[item['entry'] for item in owned.values()]}))
except Exception as error:
    signal.setitimer(signal.ITIMER_REAL,0)
    for signum in (signal.SIGTERM,signal.SIGHUP,signal.SIGINT,signal.SIGALRM): signal.signal(signum,signal.SIG_IGN)
    # On uncertainty only the already captured handles remain safe to signal.
    for item in sorted(owned.values(),key=lambda x:x['depth'],reverse=True):
        try: signal.pidfd_send_signal(item['fd'],signal.SIGKILL,None,0)
        except ProcessLookupError: pass
        except OSError:
            # If termination itself is denied, do not strand a process we held.
            try: signal.pidfd_send_signal(item['fd'],signal.SIGCONT,None,0)
            except OSError: pass
    print('WSL runtime tree termination unconfirmed: '+str(error),file=sys.stderr)
    sys.exit(73)
finally:
    signal.setitimer(signal.ITIMER_REAL,0)
    for item in owned.values(): os.close(item['fd'])
`;
  const encoded = Buffer.from(script, 'utf8').toString('base64');
  return `printf %s '${encoded}' | base64 -d | python3 -`;
}
