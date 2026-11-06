// The authorisation-entry helpers live in @sluice/solver, because the solver service re-checks every entry it signs or submits.
export {
  buildPreimage, checkSignature, checkSignatureBy, expectedSolverTree, expectedTrees, isAddressEntry, readSignatures, reviewEntry, reviewSolverEntry, withExpiration,
  type EntryProblem,
} from "@sluice/solver";
