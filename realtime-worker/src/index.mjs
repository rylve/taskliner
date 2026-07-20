const DurableObjectBase = globalThis.DurableObject || class {};

export class TasklinerSyncRoom extends DurableObjectBase {
  constructor(state, env) {
    super(state, env);
    this.state = state;
  }

  async fetch(request) {
    if (request.method === "POST" && new URL(request.url).pathname === "/notify") {
      const message = await request.text();
      for (const socket of this.state.getWebSockets()) {
        try { socket.send(message); } catch { /* disconnected sockets are removed by the runtime */ }
      }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "ready" }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket, message) {
    if (message === "ping") socket.send("pong");
  }
}

export default {
  async fetch() {
    return new Response("Taskliner realtime worker", { status: 200 });
  },
};
