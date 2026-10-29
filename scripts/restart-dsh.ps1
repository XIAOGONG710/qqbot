# 重启 DSH 桌面：等一会儿再动手，让当前会话把话说完
Start-Sleep -Seconds 40
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 6
Start-Process -FilePath 'C:\Users\22601\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
