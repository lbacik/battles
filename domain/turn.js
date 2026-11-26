// PÓLIS engine — turn contract: player view, available actions, order
// validation, and turn resolution (framework-free).
//
// The turn contract behind the unchanged entry point (ADR 0005). The
// cohesive parts live under `./turn/` and are re-exported here verbatim
// (#140): no importer changes, no behaviour change.
export {
  AVAILABLE_ACTIONS_FORMAT_VERSION,
  KNOWN_ORDER_KINDS,
  ORDER_KINDS,
  ORDER_KIND_CHARGE,
  ORDER_KIND_HOLD,
  ORDER_KIND_MOVE,
  ORDER_KIND_RALLY,
  ORDER_KIND_REFORM,
  ORDER_KIND_SHOOT,
  ORDER_KIND_WITHDRAW,
  PLAYER_VIEW_FORMAT_VERSION,
  REFUSAL_BATTLE_FINISHED,
  REFUSAL_NOT_ACTIVE_SIDE,
  REFUSAL_ORDERS_REJECTED,
  REFUSAL_STALE_TURN,
  REFUSAL_UNKNOWN_BATTLE,
  REJECTION_BATTLEFIELD_EDGE,
  REJECTION_COLLISION,
  REJECTION_CONTACT_WITH_ENEMY,
  REJECTION_DUPLICATE_UNIT_ORDER,
  REJECTION_FORBIDDEN_GROUND,
  REJECTION_INVALID_CHARGE,
  REJECTION_INVALID_FORMATION,
  REJECTION_INVALID_MOVE,
  REJECTION_INVALID_SHOOT,
  REJECTION_INVALID_WITHDRAW,
  REJECTION_NOT_OWN_UNIT,
  REJECTION_NO_LINE_OF_FIRE,
  REJECTION_ORDER_NOT_PERMITTED,
  REJECTION_OUTSIDE_FRONT_ARC,
  REJECTION_OUT_OF_RANGE,
  REJECTION_OUT_OF_REACH,
  REJECTION_UNKNOWN_UNIT,
  REJECTION_UNSUPPORTED_ORDER_KIND,
  SUBMISSION_FORMAT_VERSION,
  TURN_CONTRACT_VERSION,
  TURN_PHASES,
} from './turn/constants.js';
export { otherSide } from './turn/shared.js';
export { buildPlayerView } from './turn/player-view.js';
export { availableActions } from './turn/available-actions.js';
export {
  SUBMISSION_SCHEMA,
  SubmissionParseError,
  parseSubmission,
} from './turn/submission.js';
export { validateTurn } from './turn/validate.js';
export { TurnRejectedError, resolveTurn } from './turn/resolve.js';
