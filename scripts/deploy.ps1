# Warden — Deploy to Vercel (run from Windows PowerShell)
# Make sure you have Node.js installed on Windows first!

Write-Host "Warden Deploy" -ForegroundColor Green
Write-Host "============="

# Check if vercel is installed
$vercel = Get-Command vercel -ErrorAction SilentlyContinue
if (-not $vercel) {
    Write-Host "Installing Vercel CLI..." -ForegroundColor Yellow
    npm install -g vercel
}

# Copy files to a temp deploy folder
$deployDir = "$env:TEMP\warden-deploy"
Remove-Item -Recurse -Force $deployDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

# Copy project files from WSL
$wslPath = "\\wsl$\Ubuntu\home\win11\warden"
Write-Host "Copying from $wslPath..." -ForegroundColor Cyan
Copy-Item "$wslPath\index.html" $deployDir
Copy-Item "$wslPath\vercel.json" $deployDir
Copy-Item "$wslPath\workspace" -Destination "$deployDir\workspace" -Recurse -Force
Copy-Item "$wslPath\dashboard" -Destination "$deployDir\dashboard" -Recurse -Force
Copy-Item "$wslPath\web" -Destination "$deployDir\web" -Recurse -Force

Write-Host "Files copied to $deployDir" -ForegroundColor Green

# Deploy
Set-Location $deployDir
Write-Host "Deploying to Vercel..." -ForegroundColor Cyan
vercel --prod --yes

Write-Host ""
Write-Host "Done! Your site is now live on Vercel." -ForegroundColor Green
Write-Host "Open the URL shown above in your browser." -ForegroundColor Yellow
