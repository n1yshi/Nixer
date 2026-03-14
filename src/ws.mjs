import { WebSocketServer } from "ws"

export function attachWebsocket(server, config) {
  const wss = new WebSocketServer({ noServer: true })
  const clients = new Map()

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/events")) {
      return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)
    const token = url.searchParams.get("token") || ""
    const clientId = url.searchParams.get("id") || "0"

    if (config.serverPassword && token !== config.serverPassword) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.set(clientId, ws)

      ws.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString())
          if (event.type === "ping") {
            ws.send(JSON.stringify({
              type: "pong",
              payload: {
                timestamp: event?.payload?.timestamp || Date.now()
              }
            }))
            return
          }
          if (event.type === "main-tab-claim") {
            broadcast(clients, {
              type: "main-tab-claim",
              payload: event.payload
            })
          }
        } catch {
        }
      })

      ws.on("close", () => {
        clients.delete(clientId)
      })
    })
  })

  return {
    sendEvent(type, payload) {
      broadcast(clients, { type, payload })
    }
  }
}

function broadcast(clients, message) {
  const data = JSON.stringify(message)
  for (const client of clients.values()) {
    if (client.readyState === 1) {
      client.send(data)
    }
  }
}
