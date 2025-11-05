(define-constant ERR-UNAUTHORIZED u200)
(define-constant ERR-BATCH-NOT-AGGREGATED u201)
(define-constant ERR-LISTING-EXISTS u202)
(define-constant ERR-LISTING-NOT-FOUND u203)
(define-constant ERR-INSUFFICIENT-PAYMENT u204)
(define-constant ERR-BATCH-NOT-CLOSED u205)
(define-constant ERR-INVALID-PRICE u206)
(define-constant ERR-INVALID-DESCRIPTION u207)
(define-constant ERR-ACCESS-DENIED u208)
(define-constant ERR-MARKETPLACE-CLOSED u209)

(define-data-var marketplace-owner principal tx-sender)
(define-data-var marketplace-fee-rate uint u500)
(define-data-var marketplace-active bool true)

(define-map listings
  uint
  {
    batch-id: uint,
    seller: principal,
    price: uint,
    description: (string-ascii 256),
    sample-data: (string-ascii 512),
    listed-at: uint,
    active: bool
  }
)

(define-map purchases
  { listing-id: uint, buyer: principal }
  {
    purchased-at: uint,
    amount-paid: uint
  }
)

(define-read-only (get-listing (listing-id uint))
  (map-get? listings listing-id)
)

(define-read-only (get-purchase (listing-id uint) (buyer principal))
  (map-get? purchases { listing-id: listing-id, buyer: buyer })
)

(define-read-only (is-marketplace-active)
  (var-get marketplace-active)
)

(define-read-only (get-marketplace-fee (price uint))
  (/ (* price (var-get marketplace-fee-rate)) u10000)
)

(define-read-only (get-seller-payout (price uint))
  (- price (get-marketplace-fee price))
)

(define-private (validate-price (price uint))
  (if (> price u0) (ok true) (err ERR-INVALID-PRICE))
)

(define-private (validate-description (desc (string-ascii 256)))
  (if (and (> (len desc) u0) (<= (len desc) u256))
    (ok true)
    (err ERR-INVALID-DESCRIPTION)
  )
)

(define-private (validate-batch-aggregated (batch-id uint))
  (match (contract-call? .AggregationEngine get-insight batch-id)
    insight (ok true)
    (err ERR-BATCH-NOT-AGGREGATED)
  )
)

(define-private (validate-batch-closed (batch-id uint))
  (match (contract-call? .AggregationEngine get-batch batch-id)
    batch (is-eq (get status batch) "closed")
    false
  )
  (if (validate-batch-closed batch-id) (ok true) (err ERR-BATCH-NOT-CLOSED))
)

(define-public (create-listing (batch-id uint) (price uint) (description (string-ascii 256)) (sample-data (string-ascii 512)))
  (let (
    (listing-id (hash160 (concat (to-consensus-buff? batch-id) (to-consensus-buff? tx-sender))))
    (seller tx-sender)
  )
    (asserts! (var-get marketplace-active) (err ERR-MARKETPLACE-CLOSED))
    (try! (validate-price price))
    (try! (validate-description description))
    (try! (validate-batch-aggregated batch-id))
    (try! (validate-batch-closed batch-id))
    (asserts! (is-none (map-get? listings listing-id)) (err ERR-LISTING-EXISTS))
    (map-set listings listing-id
      {
        batch-id: batch-id,
        seller: seller,
        price: price,
        description: description,
        sample-data: sample-data,
        listed-at: block-height,
        active: true
      }
    )
    (print { event: "listing-created", listing-id: listing-id, batch-id: batch-id, price: price })
    (ok listing-id)
  )
)

(define-public (update-listing (listing-id uint) (new-price uint) (new-description (string-ascii 256)))
  (let ((listing (unwrap! (map-get? listings listing-id) (err ERR-LISTING-NOT-FOUND))))
    (asserts! (is-eq (get seller listing) tx-sender) (err ERR-UNAUTHORIZED))
    (asserts! (get active listing) (err ERR-LISTING-NOT-FOUND))
    (try! (validate-price new-price))
    (try! (validate-description new-description))
    (map-set listings listing-id
      (merge listing
        {
          price: new-price,
          description: new-description
        }
      )
    )
    (print { event: "listing-updated", listing-id: listing-id })
    (ok true)
  )
)

(define-public (deactivate-listing (listing-id uint))
  (let ((listing (unwrap! (map-get? listings listing-id) (err ERR-LISTING-NOT-FOUND))))
    (asserts! (is-eq (get seller listing) tx-sender) (err ERR-UNAUTHORIZED))
    (asserts! (get active listing) (err ERR-LISTING-NOT-FOUND))
    (map-set listings listing-id
      (merge listing { active: false })
    )
    (print { event: "listing-deactivated", listing-id: listing-id })
    (ok true)
  )
)

(define-public (purchase-insight (listing-id uint))
  (let (
    (listing (unwrap! (map-get? listings listing-id) (err ERR-LISTING-NOT-FOUND)))
    (buyer tx-sender)
    (price (get price listing))
    (fee (get-marketplace-fee price))
    (payout (get-seller-payout price))
    (owner (var-get marketplace-owner))
  )
    (asserts! (var-get marketplace-active) (err ERR-MARKETPLACE-CLOSED))
    (asserts! (get active listing) (err ERR-LISTING-NOT-FOUND))
    (asserts! (is-none (map-get? purchases { listing-id: listing-id, buyer: buyer })) (err ERR-ACCESS-DENIED))
    (try! (stx-transfer? price buyer (as-contract tx-sender)))
    (try! (as-contract (stx-transfer? fee tx-sender owner)))
    (try! (as-contract (stx-transfer? payout tx-sender (get seller listing))))
    (map-set purchases
      { listing-id: listing-id, buyer: buyer }
      { purchased-at: block-height, amount-paid: price }
    )
    (print { event: "insight-purchased", listing-id: listing-id, buyer: buyer, price: price })
    (ok {
      batch-id: (get batch-id listing),
      insight: (unwrap! (contract-call? .AggregationEngine get-insight (get batch-id listing)) (err ERR-BATCH-NOT-AGGREGATED)),
      sample: (get sample-data listing)
    })
  )
)

(define-public (set-marketplace-fee-rate (new-rate uint))
  (begin
    (asserts! (is-eq tx-sender (var-get marketplace-owner)) (err ERR-UNAUTHORIZED))
    (asserts! (<= new-rate u1000) (err ERR-INVALID-PRICE))
    (var-set marketplace-fee-rate new-rate)
    (ok true)
  )
)

(define-public (toggle-marketplace (active bool))
  (begin
    (asserts! (is-eq tx-sender (var-get marketplace-owner)) (err ERR-UNAUTHORIZED))
    (var-set marketplace-active active)
    (ok true)
  )
)

(define-public (transfer-ownership (new-owner principal))
  (begin
    (asserts! (is-eq tx-sender (var-get marketplace-owner)) (err ERR-UNAUTHORIZED))
    (var-set marketplace-owner new-owner)
    (ok true)
  )
)

(define-public (get-all-active-listings)
  (let ((listing-ids (list u0 u1 u2 u3 u4 u5 u6 u7 u8 u9)))
    (fold filter-active listing-ids (list))
  )
)

(define-private (filter-active (id uint) (acc (list 10 uint)))
  (match (map-get? listings id)
    listing (if (and (get active listing) (var-get marketplace-active))
              (unwrap-panic (as-max-len? (append acc id) u10))
              acc)
    acc
  )
)