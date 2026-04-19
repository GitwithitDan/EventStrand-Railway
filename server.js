[build]
builder = "nixpacks"
buildCommand = "rm -rf node_modules && npm ci"

[deploy]
startCommand = "node server.js"
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 3
