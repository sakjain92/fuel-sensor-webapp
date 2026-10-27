// Deployment settings. The only thing a deployer changes is the IT public key below.
//
// *** DEMO KEY ***  Key id dbbf87b6 (authority/tools/install_report_key.py). Its private half and passphrase are built into the
// public demo IT page (site/it/), so anyone can open these files: internal testing only, itKeyIsTest stays true.
// Before customers: install the customer IT's own key (install_report_key.py), set itKeyIsTest to false.
// After any change here run `node tools/stamp_sw.mjs` so installed phones fetch the new file. See ENCRYPTED_FILE.md and README.md.
export const CONFIG = {
  itPublicKeyB64: 'BK5q97DJHQEirw+et98F0b9+PoefmwYNii1Vgi6SU5nnnorDnXoJ8h+nyAXZmX2X+30Ewszg7zhZdKn4JHe2ZFc=',
  itKeyId: 'dbbf87b6',
  itKeyIsTest: true,
};
