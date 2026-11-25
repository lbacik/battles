// PÓLIS engine — turn constants: contract versions, order kinds, phases,
// rejection codes, and refusal codes (framework-free).
//
// Moved verbatim from `../turn.js` (#140): the turn contract envelopes
// share one format version, and the order kinds plus the rejection and
// refusal codes belong to the ruleset slice. No behaviour lives here.

// The format version carried by every contract envelope: the submission,
// the player view, the turn decision, and the available actions. Bump it
// when any envelope shape changes.
export const TURN_CONTRACT_VERSION = 1;
export const SUBMISSION_FORMAT_VERSION = TURN_CONTRACT_VERSION;
export const PLAYER_VIEW_FORMAT_VERSION = TURN_CONTRACT_VERSION;
export const AVAILABLE_ACTIONS_FORMAT_VERSION = TURN_CONTRACT_VERSION;

// Order kinds. Hold, Move, Charge, Reform, Withdraw, Shoot, and Rally are
// permitted in this slice (Withdraw and Rally still gate permissions: an
// engaged unit may only Hold or Withdraw, a routed unit may only Rally, and a
// disordered unit cannot charge; only missile troops may Shoot).
export const ORDER_KIND_HOLD = 'Hold';
export const ORDER_KIND_MOVE = 'Move';
export const ORDER_KIND_CHARGE = 'Charge';
export const ORDER_KIND_REFORM = 'Reform';
export const ORDER_KIND_WITHDRAW = 'Withdraw';
export const ORDER_KIND_SHOOT = 'Shoot';
export const ORDER_KIND_RALLY = 'Rally';
export const ORDER_KINDS = Object.freeze([
  ORDER_KIND_HOLD,
  ORDER_KIND_MOVE,
  ORDER_KIND_CHARGE,
  ORDER_KIND_REFORM,
  ORDER_KIND_WITHDRAW,
  ORDER_KIND_SHOOT,
  ORDER_KIND_RALLY,
]);
export const KNOWN_ORDER_KINDS = Object.freeze([
  'Hold',
  'Move',
  'Charge',
  'Reform',
  'Shoot',
  'Rally',
  'Withdraw',
]);

// Resolution phases, in order. Each runs every turn, even while empty.
export const TURN_PHASES = Object.freeze(['Movement', 'Shooting', 'Combat', 'Cohesion']);

// Rejection codes. The first three are the contract minimum; the rest belong
// to this ruleset slice and grow with its major version.
export const REJECTION_UNKNOWN_UNIT = 'unknown_unit';
export const REJECTION_NOT_OWN_UNIT = 'not_own_unit';
export const REJECTION_DUPLICATE_UNIT_ORDER = 'duplicate_unit_order';
export const REJECTION_UNSUPPORTED_ORDER_KIND = 'unsupported_order_kind';
// Move rejection codes (see `./movement.js` for the check order and the
// `details` shapes).
export const REJECTION_INVALID_MOVE = 'invalid_move';
export const REJECTION_COLLISION = 'collision';
export const REJECTION_BATTLEFIELD_EDGE = 'battlefield_edge';
export const REJECTION_FORBIDDEN_GROUND = 'forbidden_ground';
export const REJECTION_OUT_OF_REACH = 'out_of_reach';
export const REJECTION_CONTACT_WITH_ENEMY = 'contact_with_enemy';
// Charge rejection codes (see `./charge.js`). `order_not_permitted` also
// gates Move and Charge for engaged, routed, and disordered units.
export const REJECTION_ORDER_NOT_PERMITTED = 'order_not_permitted';
export const REJECTION_OUTSIDE_FRONT_ARC = 'outside_front_arc';
export const REJECTION_INVALID_CHARGE = 'invalid_charge';
// Reform rejection codes (see `./reform.js`). `order_not_permitted` gates
// Reform for engaged and routed units.
export const REJECTION_INVALID_FORMATION = 'invalid_formation';
// Withdraw rejection codes (see `./withdraw.js`). `order_not_permitted`
// gates Withdraw for units that are not engaged (as well as routed units).
export const REJECTION_INVALID_WITHDRAW = 'invalid_withdraw';
// Shoot rejection codes (see `./shoot.js`). `order_not_permitted` gates
// Shoot for engaged and routed units (as for the other orders) and for troop
// types without missiles.
export const REJECTION_INVALID_SHOOT = 'invalid_shoot';
export const REJECTION_OUT_OF_RANGE = 'out_of_range';
export const REJECTION_NO_LINE_OF_FIRE = 'no_line_of_fire';

// Whole-submission refusal codes: a stale turn number or a side that is not
// active refuses the submission before any order is examined.
export const REFUSAL_STALE_TURN = 'stale_turn';
export const REFUSAL_NOT_ACTIVE_SIDE = 'not_active_side';
export const REFUSAL_UNKNOWN_BATTLE = 'unknown_battle';
export const REFUSAL_ORDERS_REJECTED = 'orders_rejected';
// A finished battle refuses every further decision: no order validates and no
// turn resolves once the status has left `ongoing`.
export const REFUSAL_BATTLE_FINISHED = 'battle_finished';
