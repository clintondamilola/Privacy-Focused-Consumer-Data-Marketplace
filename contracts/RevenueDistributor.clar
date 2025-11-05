(define-constant ERR-UNAUTHORIZED u300)
(define-constant ERR-BATCH-NOT-SOLD u301)
(define-constant ERR-INSUFFICIENT-SHARES u302)
(define-constant ERR-DISTRIBUTION-CLAIMED u303)
(define-constant ERR-INVALID-SHARE u304)
(define-constant ERR-BATCH-NOT-FOUND u305)
(define-constant ERR-CLAIM-WINDOW-CLOSED u306)
(define-constant ERR-ZERO-VALUE u307)

(define-data-var claim-window-blocks uint u100)
(define-data-var distributor-admin principal tx-sender)

(define-map contributions
  { batch-id: uint, contributor: principal }
  { value: uint, weight: uint, claimed: bool }
)

(define-map batch-revenue
  uint
  {
    total-revenue: uint,
    total-weight: uint,
    distributed: bool,
    sale-block: uint,
    listing-id: (optional uint)
  }
)

(define-map claims
  { batch-id: uint, contributor: principal }
  { amount: uint, claimed-at: (optional uint) }
)

(define-read-only (get-contribution (batch-id uint) (contributor principal))
  (map-get? contributions { batch-id: batch-id, contributor: contributor })
)

(define-read-only (get-batch-revenue (batch-id uint))
  (map-get? batch-revenue batch-id)
)

(define-read-only (get-claim (batch-id uint) (contributor principal))
  (map-get? claims { batch-id: batch-id, contributor: contributor })
)

(define-read-only (can-claim (batch-id uint) (contributor principal))
  (let (
    (contrib (map-get? contributions { batch-id: batch-id, contributor: contributor }))
    (revenue (map-get? batch-revenue batch-id))
  )
    (and
      (is-some contrib)
      (is-some revenue)
      (not (get claimed (unwrap-panic contrib)))
      (not (get distributed (unwrap-panic revenue)))
      (> (get total-revenue (unwrap-panic revenue)) u0)
      (> (get total-weight (unwrap-panic revenue)) u0)
    )
  )
)

(define-private (validate-share (share uint))
  (if (and (> share u0) (<= share u10000)) (ok true) (err ERR-INVALID-SHARE))
)

(define-public (register-contribution (batch-id uint) (contributor principal) (value uint) (weight uint))
  (let ((admin (var-get distributor-admin)))
    (asserts! (is-eq tx-sender admin) (err ERR-UNAUTHORIZED))
    (asserts! (> value u0) (err ERR-ZERO-VALUE))
    (asserts! (> weight u0) (err ERR-ZERO-VALUE))
    (map-set contributions
      { batch-id: batch-id, contributor: contributor }
      { value: value, weight: weight, claimed: false }
    )
    (print { event: "contribution-registered", batch-id: batch-id, contributor: contributor, weight: weight })
    (ok true)
  )
)

(define-public (record-sale (batch-id uint) (listing-id uint) (revenue uint))
  (let (
    (admin (var-get distributor-admin))
    (existing (map-get? batch-revenue batch-id))
  )
    (asserts! (is-eq tx-sender (contract-call? .InsightMarketplace get-contract-address)) (err ERR-UNAUTHORIZED))
    (asserts! (is-none existing) (err ERR-BATCH-NOT-SOLD))
    (asserts! (> revenue u0) (err ERR-ZERO-VALUE))
    (let (
      (total-weight (default-to u0 (fold sum-weights (list contributor1 contributor2 contributor3 contributor4 contributor5) u0)))
    )
      (asserts! (> total-weight u0) (err ERR-INSUFFICIENT-SHARES))
      (map-set batch-revenue batch-id
        {
          total-revenue: revenue,
          total-weight: total-weight,
          distributed: false,
          sale-block: block-height,
          listing-id: (some listing-id)
        }
      )
      (print { event: "sale-recorded", batch-id: batch-id, revenue: revenue, total-weight: total-weight })
      (ok true)
    )
  )
)

(define-private (sum-weights (contrib principal) (acc uint))
  (let ((c (map-get? contributions { batch-id: (var-get current-batch-id), contributor: contrib })))
    (+ acc (default-to u0 (get weight c)))
  )
)

(define-data-var current-batch-id uint u0)

(define-private (with-batch-id (batch-id uint) (action (lambda)))
  (begin
    (var-set current-batch-id batch-id)
    (action)
  )
)

(define-public (claim-revenue (batch-id uint))
  (let (
    (contributor tx-sender)
    (contrib (unwrap! (map-get? contributions { batch-id: batch-id, contributor: contributor }) (err ERR-BATCH-NOT-FOUND)))
    (revenue-data (unwrap! (map-get? batch-revenue batch-id) (err ERR-BATCH-NOT-SOLD)))
    (window-end (+ (get sale-block revenue-data) (var-get claim-window-blocks)))
  )
    (asserts! (not (get claimed contrib)) (err ERR-DISTRIBUTION-CLAIMED))
    (asserts! (<= block-height window-end) (err ERR-CLAIM-WINDOW-CLOSED))
    (let (
      (share (/ (* (get weight contrib) (get total-revenue revenue-data)) (get total-weight revenue-data)))
    )
      (asserts! (> share u0) (err ERR-ZERO-VALUE))
      (try! (as-contract (stx-transfer? share tx-sender contributor)))
      (map-set contributions
        { batch-id: batch-id, contributor: contributor }
        (merge contrib { claimed: true })
      )
      (map-set claims
        { batch-id: batch-id, contributor: contributor }
        { amount: share, claimed-at: (some block-height) }
      )
      (print { event: "revenue-claimed", batch-id: batch-id, contributor: contributor, amount: share })
      (ok share)
    )
  )
)

(define-public (emergency-withdraw (batch-id uint))
  (let (
    (revenue-data (unwrap! (map-get? batch-revenue batch-id) (err ERR-BATCH-NOT-FOUND)))
    (admin (var-get distributor-admin))
  )
    (asserts! (is-eq tx-sender admin) (err ERR-UNAUTHORIZED))
    (asserts! (not (get distributed revenue-data)) (err ERR-UNAUTHORIZED))
    (let ((window-end (+ (get sale-block revenue-data) (var-get claim-window-blocks))))
      (asserts! (> block-height window-end) (err ERR-CLAIM-WINDOW-CLOSED))
      (map-set batch-revenue batch-id
        (merge revenue-data { distributed: true })
      )
      (try! (as-contract (stx-transfer? (get total-revenue revenue-data) tx-sender admin)))
      (ok true)
    )
  )
)

(define-public (set-claim-window (blocks uint))
  (begin
    (asserts! (is-eq tx-sender (var-get distributor-admin)) (err ERR-UNAUTHORIZED))
    (asserts! (> blocks u10) (err ERR-ZERO-VALUE))
    (var-set claim-window-blocks blocks)
    (ok true)
  )
)

(define-public (transfer-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get distributor-admin)) (err ERR-UNAUTHORIZED))
    (var-set distributor-admin new-admin)
    (ok true)
  )
)

(define-read-only (get-contract-address)
  (ok (as-contract tx-sender))
)

(define-private (contributor1) (unwrap-panic (element-at (list tx-sender) u0)))
(define-private (contributor2) (unwrap-panic (element-at (list tx-sender) u0)))
(define-private (contributor3) (unwrap-panic (element-at (list tx-sender) u0)))
(define-private (contributor4) (unwrap-panic (element-at (list tx-sender) u0)))
(define-private (contributor5) (unwrap-panic (element-at (list tx-sender) u0)))