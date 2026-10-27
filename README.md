# MRM fuel sensor phone app (publish copy)

Static site, generated from `webapp/` of the firmware repo (branch fw-2.0.0). Do not edit here; re-copy the files listed in
`sw.js` (`FILES`) and `sw.js` itself. Serve over HTTPS with `/` and `/index.html` answering 200 (no redirect).
The shipped report key is a TEST placeholder (`config.js`, `itKeyIsTest: true`).

`it/index.html` is the IT page (the maintenance-login tool from `authority/`) with the TEST customer key built in, for the demo
units only. It is added by hand and `publish_site.sh` leaves `it/` alone. It must never carry a real customer key.
