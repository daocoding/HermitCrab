# Chapter 07: Self-Healing Architecture 🛡️

A system isn't truly an "assistant" if you have to ssh into your server and manually restart Node.js scripts every morning. **HermitCrab must survive power outages, memory leaks, and broken code.**

We use native operating system features like `launchd` (on Mac) or `systemd` (on Linux) to provide bullet-proof system administration for our personal AIs.

## The macOS `launchd` setup
For MacOS, we expose three core commands. 
If your orchestrator crashes at 4 AM, `launchd` will automatically restart the process, so you still have your personalized morning news digest when you wake up.

We configure the `.plist` file to:
- `KeepAlive = true` (Revive the AI if it is killed!)
- Use `node` with flags pointing to the `orchestrator.js`.

**The Three-Tier Fail-safes:**
1. **The Guard:** We wrap execution in a bash loop that detects failure codes.
2. **The Caffeinate Tool:** `caffeinate -dsu` prevents the local Mac Mini from ever sleeping while the Bridge is running.
3. **The Notification System:** In the very rare event of a Hard Crash where the system cannot restart itself, a `curl -s ntfy.sh/...` endpoint sends a push notification directly to your phone: *"WARNING: Teams Bridge went offline."*

*(Checkout the `orchestrator/com.hermitcrab.orchestrator.plist` example in the repository!)*
