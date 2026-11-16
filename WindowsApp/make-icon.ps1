# Draws the FreeTility CAD PRO icon (isometric block with a hole + amber fillet mark)
# and writes app.ico with PNG images at 16..256 px. Run: powershell -File make-icon.ps1
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Draw-Icon([int]$S) {
  $bmp = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $S / 108.0
  # rounded square background, slate -> teal
  $r = 22 * $k
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = $S - 1
  $path.AddArc(0, 0, 2*$r, 2*$r, 180, 90); $path.AddArc($w-2*$r, 0, 2*$r, 2*$r, 270, 90)
  $path.AddArc($w-2*$r, $w-2*$r, 2*$r, 2*$r, 0, 90); $path.AddArc(0, $w-2*$r, 2*$r, 2*$r, 90, 90); $path.CloseFigure()
  $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.PointF]::new(0,0)), ([System.Drawing.PointF]::new($S,$S)), ([System.Drawing.Color]::FromArgb(255,30,41,59)), ([System.Drawing.Color]::FromArgb(255,15,118,110))
  $g.FillPath($bg, $path)
  $P = { param($x, $y) [System.Drawing.PointF]::new(($x - 54) * 1.25 * $k + $S/2, ($y - 56) * 1.25 * $k + $S/2) }
  $left  = @( (& $P 32 42.7), (& $P 54 55.4), (& $P 54 80.8), (& $P 32 68.1) )
  $right = @( (& $P 54 55.4), (& $P 76 42.7), (& $P 76 68.1), (& $P 54 80.8) )
  $top   = @( (& $P 54 30), (& $P 76 42.7), (& $P 54 55.4), (& $P 32 42.7) )
  $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,204,251,241))), $left)
  $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,153,246,228))), $right)
  $g.FillPolygon((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $top)
  $c = & $P 54 42.7
  $ew = 18 * 1.25 * $k; $eh = 10.4 * 1.25 * $k
  $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,15,118,110))), $c.X - $ew/2, $c.Y - $eh/2, $ew, $eh)
  if ($S -ge 32) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255,245,158,11)), ([Math]::Max(1.5, 4 * $k))
    $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
    $a = & $P 62 24
    $g.DrawArc($pen, $a.X, $a.Y, 16 * 1.25 * $k, 16 * 1.25 * $k, 270, 90)
  }
  $g.Dispose()
  return $bmp
}

$sizes = 16, 24, 32, 48, 64, 128, 256
$pngs = @()
foreach ($s in $sizes) {
  $b = Draw-Icon $s
  $ms = New-Object System.IO.MemoryStream
  $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += ,($ms.ToArray())
  if ($s -eq 256) { $b.Save((Join-Path $here 'icon-256.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
  $b.Dispose()
}
$out = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $out
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $d = $pngs[$i]
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s }))); $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([UInt16]1); $bw.Write([UInt16]32)
  $bw.Write([UInt32]$d.Length); $bw.Write([UInt32]$offset)
  $offset += $d.Length
}
foreach ($d in $pngs) { $bw.Write($d) }
[System.IO.File]::WriteAllBytes((Join-Path $here 'app.ico'), $out.ToArray())
Write-Output "app.ico written"
