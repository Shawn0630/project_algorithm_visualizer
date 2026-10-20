$port = 8088
$processId = Get-NetTCPConnection | Where-Object Localport -eq $port
if (!$processId) {
    Write-Output "No service is deployed on $port"
} else {
    Write-Output "Shutting down service on $port"
    Stop-Process -Id (Get-NetTCPConnection -LocalPort $port).OwningProcess -Force
}