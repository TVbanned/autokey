$anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImloYmVna3B2cXJ0eWNzZm1rbGFnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwOTkyODQsImV4cCI6MjA5OTY3NTI4NH0.6jmPv9_4S5zWzcmLo5tc2U4klU4tC4nZAeRcKrOrmVo"
$headers = @{
  "Authorization" = "Bearer $anonKey"
  "apikey" = $anonKey
  "Content-Type" = "application/json"
}
$body = '{"appId":"3274580"}'
try {
  $r = Invoke-RestMethod -Uri "https://ihbegkpvqrtycsfmklag.supabase.co/functions/v1/steam-appdetails" -Method Post -Headers $headers -Body $body
  Write-Output "success: $($r.success)"
  Write-Output "title: $($r.game.title)"
  Write-Output "release_date: $($r.game.release_date)"
} catch {
  Write-Output "Error: $($_.Exception.Message)"
}
