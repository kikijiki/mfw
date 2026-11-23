# Exposing mfw beyond loopback

mfw runs agents with your permissions, so its listener stays on loopback by
default. To reach it from another device, put a TLS proxy in front of it.

The server refuses to start on a non-loopback address unless it has its own TLS
or a named trusted proxy. It also refuses an unset `HOST`, because the runtime
would then listen on every interface, and it never listens on a wildcard
address such as `0.0.0.0`. There is no override flag.

## Tailscale Serve

Give mfw its own HTTPS port. Set this in the service environment:

```sh
HOST=127.0.0.1
PORT=7777
MFW_TRUSTED_PROXIES=127.0.0.1
MFW_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net:8443
```

Then publish it:

```sh
tailscale serve --bg --https=8443 --set-path /mfw http://127.0.0.1:7777/mfw
```

Open `https://<machine>.<tailnet>.ts.net:8443/mfw/`. The `/mfw` in the target is
deliberate: Serve strips the mount path, and the app is built under that prefix.

This setup has not yet been run against a real `tailscale serve`. Use
`tools/tailscale-serve-check.sh` and the checklist below before relying on it.

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
| `MFW_TRUSTED_PROXIES` | none | proxy peer addresses or CIDRs, no wider than /8 (IPv4) or /32 (IPv6) |
| `MFW_ALLOWED_HOSTS` | none | exact `host` or `host:port` names; wildcards and leading dots stop the server |
| `NITRO_SSL_CERT`, `NITRO_SSL_KEY` | none | the server's own TLS; set both or neither |

Loopback is **not** trusted automatically. Through a proxy, a bare allowed name
means the default HTTPS port only, so a non-default port must be listed with it.

From a trusted peer, forwarded headers must be well formed or the request is
refused. `X-Forwarded-For` and `X-Forwarded-Proto` are required together, the
scheme must be `https`, and `Forwarded` and `X-Forwarded-*` may not be mixed. The
client is the rightmost address that is not a trusted proxy.

## Why mfw needs its own origin

The browser keeps the per-session request key in `localStorage`, which belongs to
one origin (scheme, host and port). Anything else served on that origin can read
it, whatever its path. So do not mount mfw under a path of a site that serves
other apps: `--set-path /mfw` on a shared port gives those apps your session.

Cookies are weaker than origins: they ignore the port. A sibling HTTPS port on the
same name can receive the session cookie and plant its own. Neither gets it into
mfw, because every API call also needs the key, and mfw tries each cookie value
it receives. A separate port is therefore enough, and a separate name is better.

## Threat notes

- **A loopback proxy can be impersonated locally.** With
  `MFW_TRUSTED_PROXIES=127.0.0.1`, any local process that can reach loopback can
  send forged forwarded headers. Task and repair runs have no host network, but
  other run kinds may still share loopback.
- **What limits that forgery.** A forged address gets a fresh per-address bucket,
  so all proxied attempts also share one failure count. After 20 failures they
  are paced to one attempt per 2 seconds. This delays rather than locks, so a
  forger cannot keep the owner out with a lock, though a sustained flood can fill
  the queue and make sign-in slow or briefly refused. `mfw auth unlock` clears the
  count. Use a long password.
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
- [ ] Failed sign-ins from one device do not lock out a second device.
- [ ] `tailscale serve --https=<spare-port> off` removes the mapping afterwards.
