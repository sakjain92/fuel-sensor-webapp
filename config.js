// Deployment settings. The only thing a deployer changes is the IT public key below.
//
// *** TEST PLACEHOLDER ***  The key below is a throw-away P-256 public key whose private half was discarded when it was
// generated, so NOBODY can open report files encrypted to it. Before the page goes to customers:
//   1. replace itPublicKeyB64 with the customer IT's real key (raw 65-byte uncompressed P-256 point, base64);
//   2. set itKeyIsTest to false;
//   3. run `node tools/stamp_sw.mjs` so installed phones fetch the new file.
// See ENCRYPTED_FILE.md (key format) and README.md (deployment).
export const CONFIG = {
  itPublicKeyB64: 'BOOqSCxGLRS0g2oyeWWyP0qDIy8gyWXW3OmzteoPPV/0I0L2ygyuhKYt7y4KVQTkWFsmexRF9/PAgOrohJoaEtk=',
  itKeyIsTest: true,
};
