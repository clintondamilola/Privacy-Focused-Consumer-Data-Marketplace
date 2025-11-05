(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-BATCH-NOT-FOUND u101)
(define-constant ERR-BATCH-CLOSED u102)
(define-constant ERR-INVALID-K u103)
(define-constant ERR-INSUFFICIENT-DATA u104)
(define-constant ERR-INVALID-VALUE u105)
(define-constant ERR-INVALID-CATEGORY u106)
(define-constant ERR-AGGREGATION-FAILED u107)
(define-constant ERR-BATCH-EXISTS u108)
(define-constant ERR-INVALID-TIMESTAMP u109)
(define-constant ERR-ZERO-CONTRIBUTION u110)

(define-data-var next-batch-id uint u0)
(define-data-var min-k-anonymity uint u5)
(define-data-var aggregation-fee uint u1000)

(define-map data-submissions
  { batch-id: uint, user-id: principal }
  { value: uint, category: (string-ascii 32), timestamp: uint }
)

(define-map batches
  uint
  {
    category: (string-ascii 32),
    k-anonymity: uint,
    status: (string-ascii 12),
    submission-count: uint,
    sum-values: uint,
    sum-squares: uint,
    min-value: (optional uint),
    max-value: (optional uint),
    created-at: uint,
    closed-at: (optional uint)
  }
)

(define-map batch-insights
  uint
  {
    mean: uint,
    variance: uint,
    std-dev: uint,
    count: uint,
    min-val: uint,
    max-val: uint,
    generated-at: uint
  }
)

(define-read-only (get-batch (batch-id uint))
  (map-get? batches batch-id)
)

(define-read-only (get-insight (batch-id uint))
  (map-get? batch-insights batch-id)
)

(define-read-only (get-user-submission (batch-id uint) (user principal))
  (map-get? data-submissions { batch-id: batch-id, user-id: user })
)

(define-read-only (is-batch-open (batch-id uint))
  (match (map-get? batches batch-id)
    batch (is-eq (get status batch) "open")
    false
  )
)

(define-private (validate-category (cat (string-ascii 32)))
  (or 
    (is-eq cat "app-usage")
    (is-eq cat "screen-time")
    (is-eq cat "location")
    (is-eq cat "health")
    (err ERR-INVALID-CATEGORY)
  )
)

(define-private (validate-value (val uint))
  (if (> val u0) (ok true) (err ERR-INVALID-VALUE))
)

(define-private (validate-k (k uint))
  (if (and (>= k (var-get min-k-anonymity)) (<= k u1000))
    (ok true)
    (err ERR-INVALID-K)
  )
)

(define-private (calculate-mean (sum uint) (count uint))
  (if (> count u0)
    (/ (* sum u100) count)
    u0
  )
)

(define-private (calculate-variance (sum uint) (sum-sq uint) (count uint) (mean uint))
  (if (> count u1)
    (let ((avg-sq (/ (* sum-sq u100) count)))
      (if (>= avg-sq (* mean mean))
        (/ (- avg-sq (* mean mean)) u100)
        u0
      )
    )
    u0
  )
)

(define-private (calculate-std-dev (variance uint))
  (let (
    (sqrt-approx 
      (if (> variance u0)
        (let ((x0 variance) (x1 (/ variance u2)))
          (fold iter-sqrt (list x0 x0 x0 x0 x0) x1)
        )
        u0
      )
    ))
    sqrt-approx
  )
)

(define-private (iter-sqrt (prev uint) (curr uint))
  (if (> prev u0)
    (/ (+ curr (/ (* prev prev) curr)) u2)
    curr
  )
)

(define-public (create-batch (category (string-ascii 32)) (k-anonymity uint))
  (let (
    (batch-id (var-get next-batch-id))
    (caller tx-sender)
  )
    (try! (validate-category category))
    (try! (validate-k k-anonymity))
    (asserts! (is-none (map-get? batches batch-id)) (err ERR-BATCH-EXISTS))
    (map-set batches batch-id
      {
        category: category,
        k-anonymity: k-anonymity,
        status: "open",
        submission-count: u0,
        sum-values: u0,
        sum-squares: u0,
        min-value: none,
        max-value: none,
        created-at: block-height,
        closed-at: none
      }
    )
    (var-set next-batch-id (+ batch-id u1))
    (print { event: "batch-created", batch-id: batch-id, category: category })
    (ok batch-id)
  )
)

(define-public (submit-data (batch-id uint) (value uint) (category (string-ascii 32)))
  (let (
    (batch (unwrap! (map-get? batches batch-id) (err ERR-BATCH-NOT-FOUND)))
    (user tx-sender)
    (existing (map-get? data-submissions { batch-id: batch-id, user-id: user }))
  )
    (asserts! (is-eq (get status batch) "open") (err ERR-BATCH-CLOSED))
    (asserts! (is-eq (get category batch) category) (err ERR-INVALID-CATEGORY))
    (try! (validate-value value))
    (asserts! (is-none existing) (err ERR-UNAUTHORIZED))
    (let (
      (current-count (get submission-count batch))
      (current-sum (get sum-values batch))
      (current-sq (get sum-squares batch))
      (current-min (get min-value batch))
      (current-max (get max-value batch))
      (new-count (+ current-count u1))
      (new-sum (+ current-sum value))
      (new-sq (+ current-sq (* value value)))
      (new-min (if (is-some current-min)
                  (some (min value (unwrap-panic current-min)))
                  (some value)))
      (new-max (if (is-some current-max)
                  (some (max value (unwrap-panic current-max)))
                  (some value)))
    )
      (map-set data-submissions
        { batch-id: batch-id, user-id: user }
        { value: value, category: category, timestamp: block-height }
      )
      (map-set batches batch-id
        (merge batch
          {
            submission-count: new-count,
            sum-values: new-sum,
            sum-squares: new-sq,
            min-value: new-min,
            max-value: new-max
          }
        )
      )
      (print { event: "data-submitted", batch-id: batch-id, user: user, value: value })
      (ok true)
    )
  )
)

(define-public (close-and-aggregate (batch-id uint))
  (let (
    (batch (unwrap! (map-get? batches batch-id) (err ERR-BATCH-NOT-FOUND)))
    (count (get submission-count batch))
    (k (get k-anonymity batch))
  )
    (asserts! (is-eq (get status batch) "open") (err ERR-BATCH-CLOSED))
    (asserts! (>= count k) (err ERR-INSUFFICIENT-DATA))
    (let (
      (sum (get sum-values batch))
      (sum-sq (get sum-squares batch))
      (min-val (unwrap-panic (get min-value batch)))
      (max-val (unwrap-panic (get max-value batch)))
      (mean (calculate-mean sum count))
      (variance (calculate-variance sum sum-sq count mean))
      (std-dev (calculate-std-dev variance))
    )
      (map-set batches batch-id
        (merge batch
          {
            status: "closed",
            closed-at: (some block-height)
          }
        )
      )
      (map-set batch-insights batch-id
        {
          mean: mean,
          variance: variance,
          std-dev: std-dev,
          count: count,
          min-val: min-val,
          max-val: max-val,
          generated-at: block-height
        }
      )
      (print { event: "insight-generated", batch-id: batch-id, mean: mean, count: count })
      (ok {
        mean: mean,
        variance: variance,
        std-dev: std-dev,
        count: count
      })
    )
  )
)

(define-public (set-min-k-anonymity (new-k uint))
  (begin
    (asserts! (is-eq tx-sender (as-contract tx-sender)) (err ERR-UNAUTHORIZED))
    (try! (validate-k new-k))
    (var-set min-k-anonymity new-k)
    (ok true)
  )
)

(define-public (set-aggregation-fee (new-fee uint))
  (begin
    (asserts! (is-eq tx-sender (as-contract tx-sender)) (err ERR-UNAUTHORIZED))
    (var-set aggregation-fee new-fee)
    (ok true)
  )
)

(define-public (get-batch-stats (batch-id uint))
  (let ((batch (unwrap! (map-get? batches batch-id) (err ERR-BATCH-NOT-FOUND))))
    (ok {
      category: (get category batch),
      status: (get status batch),
      count: (get submission-count batch),
      required-k: (get k-anonymity batch),
      ready: (>= (get submission-count batch) (get k-anonymity batch))
    })
  )
)