param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Sha256
)

$ErrorActionPreference = 'Stop'
$actual = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $Sha256.ToLowerInvariant()) { throw 'Microsoft Visual C++ installer checksum mismatch.' }
$signature = Get-AuthenticodeSignature -LiteralPath $Installer
if ($signature.Status -ne 'Valid' -or
    $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') {
  throw 'Microsoft Visual C++ installer signature is not valid for Microsoft Corporation.'
}
Write-Host 'TCG Live: requesting Windows approval to install the Microsoft Visual C++ x64 runtime.'
try {
  $process = Start-Process -FilePath $Installer -ArgumentList @('/install', '/passive', '/norestart') -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  exit $process.ExitCode
} catch {
  if ($_.Exception.NativeErrorCode -eq 1223) { exit 1223 }
  throw
}
