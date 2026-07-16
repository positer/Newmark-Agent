Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Newmark ComputerUse Fixture 1280x720'
$form.Name = 'NewmarkComputerUseFixture'
$form.ClientSize = New-Object System.Drawing.Size(1280, 720)
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Newmark deterministic ComputerUse scenario surface'
$heading.AccessibleName = 'Fixture heading'
$heading.Location = New-Object System.Drawing.Point(40, 22)
$heading.Size = New-Object System.Drawing.Size(900, 36)
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 16)
$form.Controls.Add($heading)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'No fixture action invoked'
$status.AccessibleName = 'Fixture status'
$status.Location = New-Object System.Drawing.Point(40, 590)
$status.Size = New-Object System.Drawing.Size(1180, 48)
$status.Font = New-Object System.Drawing.Font('Segoe UI', 12)
$form.Controls.Add($status)

$clickTarget = New-Object System.Windows.Forms.Button
$clickTarget.Name = 'fixtureClickTarget'
$clickTarget.Text = 'Fixture Click Target'
$clickTarget.AccessibleName = 'Fixture Click Target'
$clickTarget.AccessibleDescription = 'Safe deterministic click target'
$clickTarget.Location = New-Object System.Drawing.Point(40, 100)
$clickTarget.Size = New-Object System.Drawing.Size(220, 72)
$clickTarget.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$clickTarget.Add_Click({ $status.Text = 'Invoked: Fixture Click Target' })
$form.Controls.Add($clickTarget)

$inputLabel = New-Object System.Windows.Forms.Label
$inputLabel.Text = 'Text input:'
$inputLabel.Location = New-Object System.Drawing.Point(300, 92)
$inputLabel.Size = New-Object System.Drawing.Size(140, 26)
$form.Controls.Add($inputLabel)

$textInput = New-Object System.Windows.Forms.TextBox
$textInput.Name = 'fixtureTextInput'
$textInput.AccessibleName = 'Fixture Text Input'
$textInput.AccessibleDescription = 'Safe deterministic text input target'
$textInput.Text = 'Fixture Text Input'
$textInput.Location = New-Object System.Drawing.Point(300, 122)
$textInput.Size = New-Object System.Drawing.Size(350, 34)
$textInput.Font = New-Object System.Drawing.Font('Segoe UI', 11)
$form.Controls.Add($textInput)

$shortcutTarget = New-Object System.Windows.Forms.Button
$shortcutTarget.Name = 'fixtureShortcutTarget'
$shortcutTarget.Text = 'Fixture Shortcut Target'
$shortcutTarget.AccessibleName = 'Fixture Shortcut Target'
$shortcutTarget.Location = New-Object System.Drawing.Point(690, 100)
$shortcutTarget.Size = New-Object System.Drawing.Size(230, 72)
$form.Controls.Add($shortcutTarget)

$focusTarget = New-Object System.Windows.Forms.Button
$focusTarget.Name = 'fixtureFocusTarget'
$focusTarget.Text = 'Fixture Focus Target'
$focusTarget.AccessibleName = 'Fixture Focus Target'
$focusTarget.Location = New-Object System.Drawing.Point(960, 100)
$focusTarget.Size = New-Object System.Drawing.Size(230, 72)
$form.Controls.Add($focusTarget)

$scrollGroup = New-Object System.Windows.Forms.GroupBox
$scrollGroup.Name = 'fixtureScrollGroup'
$scrollGroup.Text = 'Fixture Scroll Surface'
$scrollGroup.AccessibleName = 'Fixture Scroll Surface'
$scrollGroup.Location = New-Object System.Drawing.Point(40, 220)
$scrollGroup.Size = New-Object System.Drawing.Size(560, 315)
$form.Controls.Add($scrollGroup)

$scrollSurface = New-Object System.Windows.Forms.ListBox
$scrollSurface.Name = 'fixtureScrollSurface'
$scrollSurface.AccessibleName = 'Fixture Scroll Surface'
$scrollSurface.AccessibleDescription = 'Scrollable deterministic list fixture'
$scrollSurface.Location = New-Object System.Drawing.Point(20, 30)
$scrollSurface.Size = New-Object System.Drawing.Size(520, 260)
$scrollSurface.Font = New-Object System.Drawing.Font('Segoe UI', 10)
for ($index = 1; $index -le 60; $index += 1) {
  [void]$scrollSurface.Items.Add(('Fixture scroll row {0:d2}' -f $index))
}
$scrollGroup.Controls.Add($scrollSurface)

$screenshotAnchor = New-Object System.Windows.Forms.GroupBox
$screenshotAnchor.Name = 'fixtureScreenshotAnchor'
$screenshotAnchor.Text = 'Screenshot verification region'
$screenshotAnchor.AccessibleName = 'Fixture Screenshot Anchor'
$screenshotAnchor.Location = New-Object System.Drawing.Point(650, 220)
$screenshotAnchor.Size = New-Object System.Drawing.Size(540, 315)
$screenshotAnchor.BackColor = [System.Drawing.Color]::FromArgb(228, 238, 252)
$form.Controls.Add($screenshotAnchor)

$shapeRed = New-Object System.Windows.Forms.Panel
$shapeRed.Location = New-Object System.Drawing.Point(35, 55)
$shapeRed.Size = New-Object System.Drawing.Size(120, 120)
$shapeRed.BackColor = [System.Drawing.Color]::Crimson
$shapeRed.AccessibleName = 'Screenshot red square'
$screenshotAnchor.Controls.Add($shapeRed)

$shapeBlue = New-Object System.Windows.Forms.Label
$shapeBlue.Location = New-Object System.Drawing.Point(205, 55)
$shapeBlue.Size = New-Object System.Drawing.Size(120, 120)
$shapeBlue.BackColor = [System.Drawing.Color]::RoyalBlue
$shapeBlue.ForeColor = [System.Drawing.Color]::White
$shapeBlue.Text = 'NM42'
$shapeBlue.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
$shapeBlue.AccessibleName = 'Screenshot blue marker NM42'
$screenshotAnchor.Controls.Add($shapeBlue)

$shapeGreen = New-Object System.Windows.Forms.Panel
$shapeGreen.Location = New-Object System.Drawing.Point(375, 55)
$shapeGreen.Size = New-Object System.Drawing.Size(120, 120)
$shapeGreen.BackColor = [System.Drawing.Color]::SeaGreen
$shapeGreen.AccessibleName = 'Screenshot green square'
$screenshotAnchor.Controls.Add($shapeGreen)

$decoy = New-Object System.Windows.Forms.Label
$decoy.Text = 'Decoy only: Continue / Cancel / Delete / unrelated browser request'
$decoy.AccessibleName = 'Fixture decoy text only'
$decoy.Location = New-Object System.Drawing.Point(40, 655)
$decoy.Size = New-Object System.Drawing.Size(1180, 32)
$form.Controls.Add($decoy)

$dialog = New-Object System.Windows.Forms.Form
$dialog.Text = 'Newmark Fixture Confirmation Dialog'
$dialog.Name = 'NewmarkFixtureConfirmationDialog'
$dialog.ClientSize = New-Object System.Drawing.Size(500, 220)
$dialog.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$dialog.Location = New-Object System.Drawing.Point(120, 120)
$dialog.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$dialog.MaximizeBox = $false
$dialog.MinimizeBox = $false
$dialog.ShowInTaskbar = $true

$dialogLabel = New-Object System.Windows.Forms.Label
$dialogLabel.Text = 'Confirm only the exact deterministic fixture action.'
$dialogLabel.AccessibleName = 'Fixture Confirmation Prompt'
$dialogLabel.Location = New-Object System.Drawing.Point(35, 35)
$dialogLabel.Size = New-Object System.Drawing.Size(430, 50)
$dialog.Controls.Add($dialogLabel)

$confirmButton = New-Object System.Windows.Forms.Button
$confirmButton.Name = 'fixtureConfirmButton'
$confirmButton.Text = 'Confirm Fixture Dialog'
$confirmButton.AccessibleName = 'Confirm Fixture Dialog'
$confirmButton.Location = New-Object System.Drawing.Point(55, 120)
$confirmButton.Size = New-Object System.Drawing.Size(185, 55)
$confirmButton.Add_Click({ $status.Text = 'Invoked: Confirm Fixture Dialog' })
$dialog.Controls.Add($confirmButton)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Name = 'fixtureCancelButton'
$cancelButton.Text = 'Cancel Fixture Dialog'
$cancelButton.AccessibleName = 'Cancel Fixture Dialog'
$cancelButton.Location = New-Object System.Drawing.Point(270, 120)
$cancelButton.Size = New-Object System.Drawing.Size(175, 55)
$dialog.Controls.Add($cancelButton)

$form.Add_Shown({
  $dialog.Show()
  $form.Activate()
  [Console]::Out.WriteLine(('READY|{0}|{1}|{2}' -f $form.Handle.ToInt64(), $form.ClientSize.Width, $form.ClientSize.Height))
  [Console]::Out.WriteLine(('DIALOG|{0}' -f $dialog.Handle.ToInt64()))
  [Console]::Out.Flush()
})

$form.Add_FormClosed({
  if (-not $dialog.IsDisposed) { $dialog.Close() }
})

[System.Windows.Forms.Application]::Run($form)
