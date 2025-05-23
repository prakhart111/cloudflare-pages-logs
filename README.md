# Cloudflare Pages Monitoring Dashboard

## Why

CF pages in a great product, but idk why they don't offer a logging solution. So I had to build this.

## How

- Reverse engineered the websocket connection from CF dashboard
- Authenticated with CF API (pages version, which is also for some reason not present in their official docs)
- Authenticates, Gets the websocket URL, and then connects to it and relays the logs to the dashboard.

# Running this

1. Clone the repo
2. Add envs
3. Run `npm install`
4. Run `npm run dev`
5. Open `http://localhost:3000`
