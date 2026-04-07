$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Convert logo.png to logo.ico (preserving transparency)
Add-Type -AssemblyName System.Drawing
$src = New-Object System.Drawing.Bitmap("$dir\logo.png")
$icon = New-Object System.Drawing.Bitmap(256, 256, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($icon)
$g.DrawImage($src, 0, 0, 256, 256)
$g.Dispose()
$src.Dispose()
$icoPath = "$dir\logo.ico"
$stream = [System.IO.File]::OpenWrite($icoPath)
$writer = New-Object System.IO.BinaryWriter($stream)

# ICO header
$writer.Write([uint16]0)      # reserved
$writer.Write([uint16]1)      # type: icon
$writer.Write([uint16]1)      # image count

# ICO directory entry
$writer.Write([byte]0)        # width (0 = 256)
$writer.Write([byte]0)        # height (0 = 256)
$writer.Write([byte]0)        # color count
$writer.Write([byte]0)        # reserved
$writer.Write([uint16]1)      # planes
$writer.Write([uint16]32)     # bit count
$pngStream = New-Object System.IO.MemoryStream
$icon.Save($pngStream, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $pngStream.ToArray()
$writer.Write([uint32]$pngBytes.Length)  # size
$writer.Write([uint32]22)                # offset (6 header + 16 dir entry)

# PNG data
$writer.Write($pngBytes)
$writer.Close()
$stream.Close()
$icon.Dispose()

# Clear icon cache
$iconCache = "$env:LOCALAPPDATA\IconCache.db"
if (Test-Path $iconCache) { Remove-Item $iconCache -Force }
Stop-Process -Name explorer -Force
Start-Sleep -Seconds 1
Start-Process explorer

# Create desktop shortcut
$shortcutPath = [System.IO.Path]::Combine([Environment]::GetFolderPath("Desktop"), "ppsheet.lnk")
if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force }
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$dir\launcher.vbs"
$shortcut.WorkingDirectory = $dir
$shortcut.IconLocation = "$icoPath,0"
$shortcut.Description = "ppsheet"
$shortcut.Save()

Write-Host "Done! Shortcut created on Desktop."
