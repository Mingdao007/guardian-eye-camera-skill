# Guardian Eye camera skill

An installable assistant skill and small local viewer for using two Guardian Eye phone cameras. `eye` opens **one Chrome page** with iPhone 13 Pro on the left and iPhone X on the right. `eye-13p` opens the first camera on its own. The names are convenient defaults and the two labels and endpoints are configurable.

An agent can obtain a single decoded frame from an already-open viewer with `eye-snapshot 13p` or `eye-snapshot x`. A remote agent can use `eye-get` to fetch the frame over SSH. Images, credentials, certificates, and real local addresses are not included in this repository.

Each pane has independent display magnification and optional phone-side digital zoom. Display magnification crops only the current page. Phone-side zoom changes the stream for every viewer and is disabled until its positions have been measured for that phone; it is not evidence that an optical lens was selected. Coordinate source changes around any ongoing capture.

## Why this exists

On one iPhone X, OctoStream repeatedly closed unexpectedly during extended use. Its exact crash cause was not established; we did not diagnose a memory leak. After switching that device to Guardian Eye, the owner reported that it was working much more stably. This is one person's experience, not a controlled comparison or a claim that either app behaves the same way for everyone.

The initial Guardian Eye view had noticeable delay. In the viewer version we inspected, the browser requested a roughly one-second receive buffer. We limited the video receiver's requested buffer to 100 ms in our own browser session. In one 90-frame sample, the browser reported about 120 ms of mean receive buffering. After the change, the owner estimated both iPhone X and 13 Pro at less than half a second of overall delay while viewing 1080p video. This was a visual estimate, not an instrumented latency test or a long-term stability guarantee. Less buffering can cause more visible interruptions on a poor network.

With a viewer already open, two individual on-Mac frame requests took about 44 and 54 ms in one test. From a separate Ubuntu machine, three requests over SSH took 2.18, 2.32, and 4.46 seconds. These examples measure obtaining and transferring the image; they do not include the time an assistant needs to interpret it. Network conditions and machine load will change the result.

## Requirements

- Guardian Eye running and streaming in the foreground on each phone, with its direct browser viewer enabled and its exported certificate available.
- macOS or Linux on the viewer, Node.js 20 or newer, Google Chrome, and network reachability to each phone. The Mac implementation was tested; adapt the Chrome executable path for Linux.
- One certificate and one private credentials JSON file per camera. The file contains `username` and `password` fields and must be readable only by its owner.
- `playwright-core` 1.58.2; this controls the existing Chrome installation and does not download another browser.

## Install locally

Clone this repository, then run the following from its root on the viewer machine:

```sh
mkdir -p "$HOME/.local/share/guardian-eye" "$HOME/.local/bin" "$HOME/.config/guardian-eye"
chmod 700 "$HOME/.config/guardian-eye"
cp skills/guardian-eye-cameras/scripts/{guardian-eye.cjs,onvif-zoom.cjs,eye-snapshot.cjs,dashboard.html,package.json} "$HOME/.local/share/guardian-eye/"
for command in eye eye-13p eye-snapshot; do
  install -m 755 "skills/guardian-eye-cameras/scripts/$command" "$HOME/.local/bin/$command"
done
(cd "$HOME/.local/share/guardian-eye" && npm install --omit=dev --ignore-scripts)
```

Ensure that `~/.local/bin/` and Node.js are on your `PATH`. For a remote agent, also install `eye-get` on the other machine.

To make the assistant instructions discoverable as a Codex skill, install the
`skills/guardian-eye-cameras/` directory under `~/.codex/skills/` using your
normal skill installation workflow. An already-open conversation may not
automatically reload changed skill instructions.

Copy `settings.example.json` to `~/.config/guardian-eye/settings.json`. Replace each placeholder with the actual address, the hostname covered by the phone's certificate, and the paths of the exported certificate and credentials file. Set the Chrome path for your operating system. Create the credentials files with a private editor or an operating-system credential tool; do not put passwords in shell history. Restrict each credentials file to its owner, for example with `chmod 600`. Never commit the filled settings, credentials, certificates, screenshots, or camera URLs to a public repository.

The user-facing `eye` command keeps the private browser session alive until the page is closed. Its localhost URL is temporary; open it by running `eye`, rather than by bookmarking the URL. `eye-13p` works independently. If one configured camera is unreachable, the other can still open. The page shows an unavailable placeholder for a missing camera.

For a remote frame, configure a trusted SSH target in your local environment:

```sh
GUARDIAN_EYE_SSH_HOST=your-user@your-viewer-host eye-get 13p
```

The command prints a local image path. Its SSH connection must already work without an interactive password and the viewer must be open on the remote computer. The resulting image is a view of a decoded stream; it does not carry an independently verified physical capture timestamp. A missing camera should not block work for which video is only supplemental.

## Security and implementation

Before opening a viewer, the launcher verifies the phone's TLS certificate against the explicitly supplied certificate and hostname. It then pins the verified key only in its private Chrome process; it does not switch off TLS checks browser-wide. Credentials are injected only into requests for the corresponding configured phone origin and never appear in the dashboard HTML or command-line URLs.

The phone's page normally forbids embedding. For the two verified camera pages only, the launcher adjusts the response's `frame-ancestors` directive to allow the temporary loopback dashboard. The rest of the phone's content security policy remains intact. The snapshot socket is local and owner-only. These choices assume that the configured phones and local account are trusted. Do not expose the local dashboard, snapshot socket, or phone camera service to the public internet.

The optional source-zoom control uses the phone's ONVIF service and the required WS-Security password digest; the HTTP control connection itself is not encrypted. Use it only on a trusted local network. A per-session token and origin check protect the loopback action endpoint. The UI enables a source zoom button only when the corresponding position was entered in the local camera's `zoomPositions` object after device-specific validation. In one setup, `{"1": 0, "2": 0.0666667, "4": 0.2}` on an iPhone X produced approximately 2.04× and 4.2× relative to its widest view. On a different iPhone 13 Pro, `{"1": 0, "2": 0.0083333, "4": 0.025}` produced approximately 1.96× and 3.9×. These are image-field estimates in specific scenes, not precision calibration: the large difference between the two mappings is a reason to measure each device and not assume its values transfer to another phone, lens, app, or version. Both original positions were restored after testing. The app describes ONVIF zoom as digital; optical lens selection was not established.

The [skill entrypoint](skills/guardian-eye-cameras/SKILL.md) contains the practical agent procedure. This independent project is not affiliated with Guardian Eye or OctoStream.
