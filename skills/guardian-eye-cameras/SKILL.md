---
name: guardian-eye-cameras
description: Connect and inspect Guardian Eye phone cameras on a local network, including a low-latency dual view and on-demand frames for an agent.
---

# Guardian Eye cameras

Use this skill for an explicitly selected Guardian Eye stream. Confirm the phone is streaming, the viewer can reach its current address, and the exported camera certificate matches the camera. A phone's address can change. Keep passwords and camera images out of logs, repository history, and shared URLs.

## Watch

`eye` opens one Chrome page with the configured 13 Pro camera on the left and X on the right. `eye-13p` opens the 13 Pro only. The local launcher verifies each camera's certificate, authenticates each camera separately, and targets a 100 ms WebRTC receive buffer. A camera that fails its own connection check does not prevent the other camera from opening. This setting can trade smoothness for lower delay on poor Wi-Fi; a target is not an end-to-end latency measurement.

The phone's viewer prevents framing by default. The launcher changes only the verified phone document's `frame-ancestors` policy in its private browser session so that its loopback dashboard can embed it. Other policy directives, TLS verification, and browser-wide security settings remain in force. The dashboard itself holds no passwords and the snapshot socket is accessible only to the local user.

Each view offers independent **display zoom**: this is a crop of the displayed image and does not affect other viewers. The optional **phone digital zoom** buttons are enabled only if the local settings include positions established for that phone and configuration. They change the source image for all viewers. Guardian Eye calls its ONVIF zoom digital; do not claim optical lens switching without evidence. Do not change phone source settings during another owner's capture. The controls read back the phone's position after a requested change and do not retry an unconfirmed move automatically.

## Read a frame

When the viewer is already open, on its computer run `eye-snapshot 13p` or `eye-snapshot x`; use the returned private image path with the available image viewing tool. The image is a decoded video frame, not a new device connection. On a separate trusted SSH-connected computer, configure `GUARDIAN_EYE_SSH_HOST` and run `eye-get 13p` or `eye-get x`; this transfers one frame over SSH and prints its local path. Do not paste credentials into a shell command or print the binary output.

The frame reflects the displayed stream and has no independently verified sensor capture timestamp. For changes over time, capture a small number of frames appropriate to the question; do not treat a still frame as proof of live motion, contact, or force. If the viewer or a camera is unavailable, report that fact and continue the task when camera access is not required. Camera video is supplemental evidence, not a mandatory task or robot-safety gate.

## Setup and troubleshooting

The repository README explains the local settings file, certificate, private credentials, dependencies, and launchers. Do not disable certificate validation or share the camera outside the intended network to bypass a connection failure. The skill uses existing viewers when available and does not start additional RTSP readers during another owner's active capture without coordination.
