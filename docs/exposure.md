# Exposing mfw beyond loopback

> **Experimental.** This path has not been run against a real `tailscale serve`.
> See [experimental.md](experimental.md).

An mfw session can control agents and commands on your machine, so its listener
stays on loopback by default. To reach it from another device, put a TLS proxy in
front of it.

The server refuses to start on a non-loopback address unless it has its own TLS
or a named trusted proxy. It also refuses an unset `HOST`, because the runtime
would then listen on every interface, and it never listens on a wildcard
address such as `0.0.0.0`. There is no override flag.

## Tailscale Serve (recommended: a private socket)

Give mfw its own HTTPS port and a private unix socket. Set this in the service
environment:

```sh
HOST=127.0.0.1
PORT=7777
MFW_LISTEN_SOCKET=$HOME/.local/share/mfw/serve/mfw.sock
MFW_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net:8443
```

Then publish it. A socket target needs root:

```sh
sudo tailscale serve --bg --https=8443 unix:$HOME/.local/share/mfw/serve/mfw.sock
```

Open `https://<machine>.<tailnet>.ts.net:8443/mfw/`. Mount it at the root of its
port, without `--set-path`: the app is built under `/mfw`, and a unix target has
no path to put that prefix back.

**Unverified.** The `unix:` form comes from the help text of `tailscale serve`
1.104 and Tailscale's public source. Tailscale's published docs do not describe
it. Per that source, the backend receives `Host: localhost` and the real name in
`X-Forwarded-Host`. No real `tailscale serve` has been run against this. Use
`tools/tailscale-serve-check.sh` and the checklist below before relying on it.

The socket must be in a subdirectory of `$MFW_HOME`, because that is the tree
sandboxes cannot see. Agents run as your user, so file modes alone would not keep
them out. mfw creates the directory `0700` and the socket `0600`, refuses a
symlink, a regular file, a wider directory or a socket another server is using,
replaces a dead socket, and removes its own on exit. A request on the socket
without forwarded headers is refused. The loopback TCP port stays available for
the local browser and CLI, and forwarded headers on it are ignored.

### TCP loopback proxy (not recommended)

`MFW_TRUSTED_PROXIES=127.0.0.1` with
`tailscale serve --bg --https=8443 --set-path /mfw http://127.0.0.1:7777/mfw` also
works, and the server prints a warning at every start. See the threat notes.

## Other reverse proxies

The proxy must terminate TLS and **replace** the forwarded headers, not add to
what the client sent. Bun keeps only the last of repeated header lines, and mfw
cannot see the others, so a proxy that puts its own line before a client's would
let that client choose the value.

```nginx
location /mfw/ {
    proxy_pass http://127.0.0.1:7777;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host $http_host;
    proxy_set_header Forwarded "";
    proxy_buffering off;   # live updates use server-sent events
}
```

If the proxy is on another machine, bind mfw to a specific private address and
list only that proxy's address in `MFW_TRUSTED_PROXIES`. Direct requests from any
other peer are refused.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | required by the server; `mfw server` and `bun run start` use `127.0.0.1` | the listen address |
| `MFW_LISTEN_SOCKET` | none | a private socket for a local TLS proxy, in a subdirectory of `$MFW_HOME` |
| `MFW_TRUSTED_PROXIES` | none | proxy peer addresses or CIDRs, no wider than /8 (IPv4) or /32 (IPv6) |
| `MFW_ALLOWED_HOSTS` | none | exact `host` or `host:port` names; wildcards and leading dots stop the server |
| `NITRO_SSL_CERT`, `NITRO_SSL_KEY` | none | the server's own TLS; set both or neither |

Loopback is **not** trusted automatically. Through a proxy, a bare allowed name
means the default HTTPS port only, so a non-default port must be listed with it.

From a trusted peer, forwarded headers must be well formed or the request is
refused. `X-Forwarded-For` and `X-Forwarded-Proto` are required together, the
scheme must be `https`, and `Forwarded` and `X-Forwarded-*` may not be mixed. The
client is the rightmost address that is not a trusted proxy.

## Passkeys behind a proxy

A passkey is bound to the exact name it was added on, which mfw takes from the
external origin: the trusted proxy's forwarded host and HTTPS, or this server's
own TLS, and always one of the names in `MFW_ALLOWED_HOSTS`. It never comes from
a header a client could choose. So add passkeys through the URL you will use,
for example `https://<machine>.<tailnet>.ts.net:8443/mfw/`. Passkeys added on
`localhost` keep working there. A bare IP address cannot use passkeys at all.

Changing the external name strands the passkeys added on the old one: they stay
listed under that name in Settings > Passkeys until you revoke them, and the
password still works.

The signatures are verified by `@simplewebauthn/server`, which is given exactly
that origin and RP ID; mfw never passes it a list or a pattern. Passkeys are
discoverable only, so the public sign-in options carry no credential list, and
an unauthenticated visitor cannot tell whether any exist. Adding one needs the
password, and is announced in every other session with the address it came
from: through a proxy, that is the forwarded client.

## Why mfw needs its own origin

The browser keeps the per-session request key in `localStorage`, which belongs to
one origin (scheme, host and port). Anything else served on that origin can read
it, whatever its path. So do not mount mfw under a path of a site that serves
other apps: `--set-path /mfw` on a shared port gives those apps your session.

Cookies are weaker than origins: they ignore the port. A sibling HTTPS port on the
same name can receive the session cookie and plant its own. Neither gets it into
mfw, because every API call also needs the key, and mfw tries each cookie value
it receives. A sibling can still overwrite the cookie with the same name and
`Path=/mfw`, which signs you out but grants nothing, because the request key is
still required. A separate port keeps the key safe, and a separate name also
stops that sign-out.

## Threat notes

- **Do not trust a loopback proxy while agents share host loopback.** With
  `MFW_TRUSTED_PROXIES=127.0.0.1`, every process that can connect from loopback is
  "the proxy" and can claim any client address. Sandboxed agent runs have no host
  network, but any other local process still shares it.
- **What such a process can do.** In a security review, 40 workers rotating forged
  addresses got 11 of the owner's 12 correct sign-ins refused at once, and the 12th
  took 32 seconds, until the flood stopped. Forged attempts share one failure
  count and are paced to one per 2 seconds after 20 failures, which still allows
  about 43,000 guesses a day, roughly 450 times the rate of one locked address. A
  12-character password from a small guess space can fall to that. Use a randomly
  generated passphrase. `mfw auth unlock` clears the count, but not a live flood.
- **The private socket removes this path.** Sandboxes cannot see it, and forwarded
  headers on loopback TCP are then ignored.
- **The Host check is not authentication.** Every route still needs a session,
  and every API call still needs the request key.

## Manual check: real `tailscale serve`

`tools/tailscale-serve-check.sh <machine>.<tailnet>.ts.net:<spare-port>` starts a
throwaway server on a temporary home, tells you which `tailscale serve` command
to run, and checks the result. It does not touch your real service, and it does
not change your Serve configuration itself. Then, in a browser:

- [ ] The UI loads at the HTTPS URL and you can complete setup.
- [ ] DevTools shows `__Secure-mfw_session` with `Secure`, `HttpOnly`,
      `SameSite=Strict` and `Path=/mfw`.
- [ ] Live updates keep working for over a minute.
- [ ] On a sibling HTTPS port of the same name, run
      `document.cookie = "__Secure-mfw_session=AAAA; Secure; Path=/mfw/api; Max-Age=3600"`.
      mfw stays signed in.
- [ ] That sibling port's `localStorage` does not contain the mfw key.
- [ ] A sibling response with `Set-Cookie: __Secure-mfw_session=AAAA; Secure;
      Path=/mfw` signs you out at most. It never grants access, and signing in
      again works.
- [ ] Failed sign-ins from one device do not lock out a second device, tested
      over both IPv4 and IPv6. Tailnet addresses (`fd7a:115c:a1e0::/48`) are
      limited per address. Other IPv6 clients are limited per /64, so devices
      sharing a /64 outside that range share a limit.
- [ ] Settings > Passkeys adds a passkey on the HTTPS name, and **Sign in with a
      passkey** works from a second device that holds it (a synced passkey or a
      security key). The list shows the tailnet name, not `localhost`.
- [ ] `tailscale serve --https=<spare-port> off` removes the mapping afterwards.
