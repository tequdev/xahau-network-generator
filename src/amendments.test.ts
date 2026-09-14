import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  amendmentHash,
  commitFromReleaseinfo,
  parseAmendments,
} from './amendments.ts';

const SAMPLE = `
XRPL_FEATURE(PermissionedDomains,        Supported::no,  VoteBehavior::DefaultNo)
XRPL_FIX    (HookMap,                    Supported::yes, VoteBehavior::DefaultYes)
XRPL_RETIRE(fixXahauV2)
REGISTER_FEATURE(OwnerPaysFee,                  Supported::no,  VoteBehavior::DefaultNo);
REGISTER_FIX    (fixTrustLinesToSelf,           Supported::no,  VoteBehavior::DefaultNo);
REGISTER_FIX    (fixXahauV1,           Supported::yes,  VoteBehavior::DefaultYes);
#define REGISTER_FIX(fName, supported, votebehavior) \\
`;

test('parseAmendments extracts only supported features/fixes plus retired', () => {
  const names = parseAmendments(SAMPLE);
  assert.deepEqual(names, ['fixHookMap', 'fixXahauV2', 'fixXahauV1']);
});

test('amendmentHash matches known sha512-derived hash', () => {
  assert.equal(
    amendmentHash('MultiSign'),
    '4C97EBA926031A7CF7D7B36FDE3ED66DDA5421192D63DE53FFB46E43B9DC8373',
  );
});

test('commitFromReleaseinfo extracts 40-char commit sha', () => {
  const text =
    'commit abcdef0123456789abcdef0123456789abcdef01\nAuthor: test\n';
  assert.equal(
    commitFromReleaseinfo(text),
    'abcdef0123456789abcdef0123456789abcdef01',
  );
});
