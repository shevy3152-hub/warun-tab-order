import { BlockList, isIP } from "node:net";
import { posix } from "node:path";

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet("127.0.0.0", 8, "ipv4");
loopbackAddresses.addAddress("::1", "ipv6");

function isLoopbackAddress(address) {
  if (typeof address !== "string" || address.includes("%")) return false;
  const family = isIP(address);
  return family !== 0 && loopbackAddresses.check(address, family === 6 ? "ipv6" : "ipv4");
}

// Cover encoded separators, SPA entry aliases and Windows filename aliases.
// Only the exact /admin.html request target receives runtime credentials.
export function isStaffEntryPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes("\0")) throw new URIError("Invalid path.");
  const normalized = posix.normalize(decoded.replaceAll("\\", "/"));
  const entry = normalized.split("/")[1]?.split(":")[0].replace(/[ .]+$/, "").toLowerCase();
  return ["admin.html", "admin", "kitchen", "history"].includes(entry);
}

export function isLocalStaffRequest(request) {
  const socket = request.socket;
  // Forwarding headers are never a substitute for the actual TCP peer.
  if (!isLoopbackAddress(socket?.remoteAddress)) return false;

  const hosts = [];
  const rawHeaders = request.rawHeaders;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return false;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (typeof rawHeaders[index] !== "string") return false;
    if (rawHeaders[index].toLowerCase() === "host") hosts.push(rawHeaders[index + 1]);
  }
  if (hosts.length !== 1 || typeof hosts[0] !== "string") return false;

  // Host is an additional DNS rebinding check, not proof of a local peer.
  // Accept literal loopback addresses or exactly localhost, on this listener.
  const authority = hosts[0].match(/^(?:\[([0-9a-f:.]+)\]|([^:\s/?#@\\]+))(?::([1-9][0-9]{0,4}))?$/i);
  if (!authority) return false;
  const hostname = authority[1] ?? authority[2];
  if (authority[1] ? isIP(hostname) !== 6 : hostname.toLowerCase() !== "localhost" && isIP(hostname) !== 4) return false;
  const port = authority[3] === undefined ? 80 : Number(authority[3]);
  if (port > 65535 || port !== socket.localPort) return false;
  return hostname.toLowerCase() === "localhost" || isLoopbackAddress(hostname);
}
