[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ZipPath,
  [Parameter(Mandatory = $true)][string]$CsvPath,
  [Parameter(Mandatory = $true)][string]$ReceiptPath,
  [Parameter(Mandatory = $true)][string]$ProductId
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipFullPath = [System.IO.Path]::GetFullPath($ZipPath)
$csvFullPath = [System.IO.Path]::GetFullPath($CsvPath)
$receiptFullPath = [System.IO.Path]::GetFullPath($ReceiptPath)

function Get-FileSha256([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

function Decode-Bytes([byte[]]$Bytes) {
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  try { return $utf8.GetString($Bytes) } catch { }
  $gb = [System.Text.Encoding]::GetEncoding(54936)
  return $gb.GetString($Bytes)
}

function ConvertTo-CsvCell([object]$Value) {
  $s = if ($null -eq $Value) { '' } else { [string]$Value }
  return '"' + $s.Replace('"', '""') + '"'
}

$headerStream = [System.IO.File]::OpenRead($zipFullPath)
try {
  $header = New-Object byte[] 4
  if ($headerStream.Read($header, 0, 4) -ne 4 -or $header[0] -ne 0x50 -or $header[1] -ne 0x4b) { throw 'Input is not a ZIP archive' }
} finally { $headerStream.Dispose() }
$sourceHash = Get-FileSha256 $zipFullPath
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipFullPath)
$writer = New-Object System.IO.StreamWriter($csvFullPath, $false, [System.Text.UTF8Encoding]::new($false))
try {
  $allEntries = @($archive.Entries | Where-Object { $_.FullName -notmatch '/$' })
  $entries = @($allEntries | Where-Object { [System.IO.Path]::GetExtension($_.FullName).ToLowerInvariant() -eq '.txt' } | Sort-Object FullName)
  $writer.WriteLine('评论内容,来源文件序号,来源文件名')
  $row = 0
  foreach ($entry in $entries) {
    $stream = $entry.Open()
    try {
      $memory = New-Object System.IO.MemoryStream
      try { $stream.CopyTo($memory); $content = Decode-Bytes $memory.ToArray() }
      finally { $memory.Dispose() }
    } finally { $stream.Dispose() }
    $row += 1
    $writer.WriteLine((ConvertTo-CsvCell $content) + ',' + (ConvertTo-CsvCell $row) + ',' + (ConvertTo-CsvCell $entry.FullName))
  }
  $writer.Flush()
  $writer.Dispose()
  $receipt = [ordered]@{
    source = '评论'; status = 'COMPLETED'; productId = $ProductId
    sourceFile = [System.IO.Path]::GetFileName($ZipPath); normalizedFile = [System.IO.Path]::GetFileName($CsvPath)
    sha256 = $sourceHash; normalizedSha256 = Get-FileSha256 $csvFullPath
    entries = $entries.Count; rows = $row; excludedEntries = $allEntries.Count - $entries.Count
    deterministicOrder = 'FullName ordinal ascending; .txt entries only'
  }
  $receiptJson = $receipt | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($receiptFullPath, $receiptJson + "`n", [System.Text.UTF8Encoding]::new($false))
} finally { $writer.Dispose(); $archive.Dispose() }
