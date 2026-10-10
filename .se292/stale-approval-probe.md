# Stale-approval probe

Measurement artifact for straightedge#298. This file exists so a later commit can change
the reviewable diff in an unmistakable way, which is the one case nobody has observed:
every push seen so far changed the BASE of a pull request, never its contribution.

The question: does `dismiss_stale_reviews_on_push` fire when the contribution genuinely
changes, as opposed to when only the base moves?

Procedure:

1. This file lands on a branch and the PR is opened.   (setup)
2. Someone who is not the author approves it.          (needs a second identity)
3. A commit changes the line marked below.             (the reviewable diff genuinely changes)
4. Read `reviewDecision` and the timeline for `review_dismissed`.

Expected if the rule works as its name suggests: step 3 drops `reviewDecision` to
`REVIEW_REQUIRED` and puts a `review_dismissed` event on the timeline. Expected if it does
not: the approval survives a real content change, which would be the genuine defect this
issue has been looking for.

PROBE LINE: CHANGED-AFTER-APPROVAL-this-is-a-real-contribution-change

Delete this file and its branch once the reading is taken.
