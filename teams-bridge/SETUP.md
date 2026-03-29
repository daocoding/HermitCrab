# 🦀🏢 HermitCrab Teams Bridge — Setup Guide

## Prerequisites
- [x] Azure AD app registration (existing from OpenClaw)
- [x] M4 always-on server with Tailscale Funnel
- [x] Antigravity IDE with JARVIS workspace
- [x] antigravity-cli installed

## Step 1: Get your Azure AD credentials

1. Go to [Azure Portal](https://portal.azure.com) → App registrations
2. Find your existing bot app registration
3. Note the **Application (client) ID** → this is `MICROSOFT_APP_ID`
4. Go to Certificates & secrets → New client secret → Copy value → this is `MICROSOFT_APP_PASSWORD`
5. Note the **Directory (tenant) ID** → this is `AUTHORIZED_TENANT_ID`

## Step 2: Register as a Bot (if not already)

1. Azure Portal → Create a resource → "Azure Bot"
2. Use **existing app registration** (your App ID from Step 1)
3. Set **Messaging endpoint**: `https://zens-mac-mini.tail1b3f0c.ts.net/api/messages`
4. In the Bot's Channels section → Add "Microsoft Teams"

## Step 3: Set up Tailscale Funnel on M4

```bash
# On M4, expose the bridge port via Tailscale Funnel
tailscale funnel --bg 3979
# This creates: https://zens-mac-mini.tail1b3f0c.ts.net → localhost:3979
```

## Step 4: Create environment file on M4

```bash
cat > ~/.hermitcrab-teams-env << 'EOF'
MICROSOFT_APP_ID=your-app-id-here
MICROSOFT_APP_PASSWORD=your-app-password-here
AUTHORIZED_TENANT_ID=your-tenant-id-here
TEAMS_BRIDGE_PORT=3979
TEAMS_REPLY_PORT=18792
HERMITCRAB_WORKSPACE=/Users/tony/Library/CloudStorage/OneDrive-ApexLearn/JARVIS
EOF
chmod 600 ~/.hermitcrab-teams-env
```

## Step 5: Install and start

```bash
cd ~/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/teams-bridge
npm install
source ~/.hermitcrab-teams-env && node teams-bridge.js
```

## Step 6: Create Teams app package

1. Replace `REPLACE_WITH_YOUR_MICROSOFT_APP_ID` in `manifest.json` with your App ID
2. Create two PNG icons (32x32 outline, 192x192 color) named `outline.png` and `color.png`
3. Zip them together: `zip jarvis-teams-app.zip manifest.json outline.png color.png`

## Step 7: Sideload to Teams

1. Open Teams → Apps → Manage your apps → Upload a custom app
2. Select `jarvis-teams-app.zip`
3. Install for personal use + add to desired teams/channels

## Step 8: Create launchd plist (auto-start on M4)

```bash
cat > ~/Library/LaunchAgents/com.hermitcrab.teams-bridge.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.hermitcrab.teams-bridge</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/tony/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/teams-bridge/teams-bridge.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/Users/tony/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>/Users/tony</string>
        <key>MICROSOFT_APP_ID</key>
        <string>YOUR_APP_ID</string>
        <key>MICROSOFT_APP_PASSWORD</key>
        <string>YOUR_APP_PASSWORD</string>
        <key>AUTHORIZED_TENANT_ID</key>
        <string>YOUR_TENANT_ID</string>
        <key>TEAMS_BRIDGE_PORT</key>
        <string>3979</string>
        <key>TEAMS_REPLY_PORT</key>
        <string>18792</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/Users/tony/Library/CloudStorage/OneDrive-ApexLearn/JARVIS</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/tony/Library/Logs/HermitCrab/teams-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/tony/Library/Logs/HermitCrab/teams-bridge.err</string>
</dict>
</plist>
PLIST
```

## Architecture

```
Teams user → Teams Service → Azure Bot Service
    → POST /api/messages (port 3979 via Tailscale Funnel)
    → teams-bridge.js (acknowledges immediately)
    → antigravity-cli → JARVIS session (thinks...)
    → JARVIS runs: curl POST /reply (port 18792)
    → teams-bridge.js → Bot Framework REST API → Teams
    → User sees response
```

## Notes
- The bridge does NOT use the Bot Framework SDK — it uses raw REST API
- This keeps it lightweight and consistent with the Telegram bridge pattern
- No npm dependencies beyond what Node.js provides (http, https, crypto)
- The package.json has the Agents SDK listed but the current implementation doesn't need it
