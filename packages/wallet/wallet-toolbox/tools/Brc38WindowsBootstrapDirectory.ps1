# Maintainer build storage only; this is not the runtime HANDLE/privacy boundary.
param([Parameter(Mandatory=$true)][ValidateSet('Create','Inspect')][string]$Mode,
      [Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference = 'Stop'
$actor = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$full = [System.IO.Path]::GetFullPath($Directory)
if (-not [String]::Equals($full, $Directory, [StringComparison]::OrdinalIgnoreCase) -or
    $full.Length -gt 2048 -or $full -notmatch '^[A-Za-z]:\\') {
  throw 'Bootstrap requires a canonical local directory'
}
$drive = [System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($full))
if ($drive.DriveFormat -ne 'NTFS' -or $drive.DriveType -eq [System.IO.DriveType]::Network) { throw 'Bootstrap requires local NTFS build storage' }
function Inspect-PrivateBuildDirectory([string]$Name) {
  $item = [System.IO.DirectoryInfo]::new($Name)
  if (-not $item.Exists) { throw 'Bootstrap directory does not exist' }
  for ($ancestor = $item; $null -ne $ancestor; $ancestor = $ancestor.Parent) {
    if (($ancestor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Bootstrap directory has a reparse ancestor'
    }
  }
  $acl = $item.GetAccessControl()
  if (-not $acl.AreAccessRulesProtected -or
      $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $actor.Value) {
    throw 'Bootstrap build directory requires protected actor ownership'
  }
  $fullControl = $false
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) {
      if ($rule.IdentityReference.Value -ne $actor.Value) {
        throw 'Bootstrap build directory grants another actor access'
      }
      if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl) { $fullControl = $true }
    }
  }
  if (-not $fullControl) { throw 'Bootstrap actor has no full build-directory access' }
}
Inspect-PrivateBuildDirectory $full
if ($Mode -eq 'Create') {
  $full = [System.IO.Path]::Combine($full, 'brc38-windows-bootstrap-' + [Guid]::NewGuid().ToString('N'))
  if ([System.IO.Directory]::Exists($full) -or [System.IO.File]::Exists($full)) {
    throw 'Bootstrap child already exists'
  }
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($actor)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $actor, [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
    [System.Security.AccessControl.PropagationFlags]::None,
    [System.Security.AccessControl.AccessControlType]::Allow)
  $acl.AddAccessRule($rule)
  [System.IO.Directory]::CreateDirectory($full, $acl) | Out-Null
  Inspect-PrivateBuildDirectory $full
}
[ordered]@{protocol='brc38-windows-bootstrap-directory/v1';directory=$full;actorSid=$actor.Value;
           protectedActorOnly=$true;runtimeIdentityAuthority=$false} | ConvertTo-Json -Compress
