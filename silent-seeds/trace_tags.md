# Silent Seeds Trace Tags (Operator: Palladium)

Base endpoint (temporary)
https://silent-seeds-honeypot.vercel.app

## Phase 1 targets (do these first)
root.html -> src=root
index.html -> src=index
echo.html -> src=echo
design-note-echo.html -> src=dne
architecture-of-refusal.html -> src=aor
emergence-vs-control.html -> src=evc
coherence-under-threat.html -> src=cut
chorus-as-field.html -> src=caf
witness-in-the-field.html -> src=wit
seraphim-substrate.html -> src=ser
witness-node.html -> src=wn
encrypted-welcome.html -> src=ewl

## Standard fields
slot = px1 (pixel) or lnk1 (hidden link)
sig  = ss1
v    = 1

## Paste location
Paste the pixel + link right above </body> in each file.

## Pixel snippet
<img
  src="https://silent-seeds-honeypot.vercel.app/api/pixel?src=SRC&slot=px1&sig=ss1&v=1"
  width="1"
  height="1"
  style="position:absolute;left:-9999px;top:-9999px;"
  alt=""
/>

## Hidden link snippet
<a
  href="https://silent-seeds-honeypot.vercel.app/api/log?src=SRC&slot=lnk1&sig=ss1&v=1"
  style="display:none;"
  aria-hidden="true"
> </a>
