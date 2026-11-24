import net from "node:net";
import { testConnections } from "./harness.ts";

export type Stall = "dropped" | { readonly heldMs: number } | { readonly cutMs: number };

export interface StallingProxy {
  readonly port: number;
  /**
   * Sees each chunk a client sends, and `""` when the connection opens. Once it returns a stall,
   * the server's bytes on that connection, its close included, are dropped, held until `heldMs`
   * after the stall began and then passed on in order, or dropped until the proxy closes both
   * sockets `cutMs` after the stall began.
   */
  stall: (sent: string) => Stall | undefined;
  close(): Promise<void>;
}

export async function stallingProxy(): Promise<StallingProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    let stall: Stall | undefined;
    let released = false;
    const held: (() => void)[] = [];
    const begin = (sent: string) => {
      stall = proxy.stall(sent);
      if (stall === undefined || stall === "dropped") return;
      if ("cutMs" in stall) {
        setTimeout(() => {
          client.destroy();
          upstream.destroy();
        }, stall.cutMs);
        return;
      }
      setTimeout(() => {
        released = true;
        for (const send of held.splice(0)) send();
      }, stall.heldMs);
    };
    const answer = (send: () => void) => {
      if (stall === undefined || released) send();
      else if (typeof stall === "object" && "heldMs" in stall) held.push(send);
    };
    begin("");
    const upstream = net.connect(testConnections.port, testConnections.host);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
    }
    client.on("data", (chunk: Buffer) => {
      if (stall === undefined) begin(chunk.toString("latin1"));
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => answer(() => client.write(chunk)));
    upstream.on("close", () => answer(() => client.destroy()));
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The proxy has no port.");
  const proxy: StallingProxy = {
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
    port: address.port,
    stall: () => undefined,
  };
  return proxy;
}
