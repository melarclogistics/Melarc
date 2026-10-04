# Feature specifications

One feature is documented once by business domain, even when it spans multiple surfaces. Contracts own entities, states, permissions, settings, errors, audit events and operations; feature documents own workflow behavior and acceptance criteria.

These are specifications, not claims that code has been built. Read only the feature and dependencies relevant to the bounded task. Historical decision/question identifiers are provenance; current rules and unresolved requirements are stated in the retained sources.

## Feature index

| Domain | Feature |
|---|---|
| delivery | [Carrier handoff](delivery/carrier-handoff.md) |
| delivery | [Recipient cash collection and custody](delivery/cash-collection.md) |
| delivery | [Delivery failure and reattempt](delivery/delivery-failure.md) |
| delivery | [Doorstep delivery](delivery/doorstep-delivery.md) |
| dispatch | [Atomic dispatch](dispatch/atomic-dispatch.md) |
| dispatch | [Delivery-run build](dispatch/delivery-run-build.md) |
| dispatch | [Recipient confirmation](dispatch/recipient-confirmation.md) |
| hub | [Hub Intake](hub/hub-intake.md) |
| hub | [Itemization and Pricing](hub/itemization.md) |
| identity | [Credential recovery](identity/credential-recovery.md) |
| identity | [Permission enforcement](identity/permission-enforcement.md) |
| identity | [Rider authentication](identity/rider-authentication.md) |
| identity | [Staff authentication](identity/staff-authentication.md) |
| identity | [Vendor authentication](identity/vendor-authentication.md) |
| operations | [Exception ownership matrix](operations/exception-ownership-matrix.md) |
| operations | [Hub daily operating cycle](operations/hub-daily-operating-cycle.md) |
| payments | [Accounting Export](payments/accounting-export.md) |
| payments | [Financial Adjustment Resolution](payments/financial-adjustment-resolution.md) |
| pickup | [Pickup Collection](pickup/pickup-collection.md) |
| pickup | [Pickup Failure](pickup/pickup-failure.md) |
| pickup | [Pickup Manifest](pickup/pickup-manifest.md) |
| pickup | [Pickup Request](pickup/pickup-request.md) |
| reporting | [Daily Operations & Cash Report](reporting/daily-operations-and-cash-report.md) |
| returns | [Return to Vendor](returns/return-to-vendor.md) |
| vendor | [Vendor onboarding and account allowance](vendor/vendor-onboarding-and-allowance.md) |
| vendor | [Vendor saved pickup locations](vendor/vendor-pickup-locations.md) |
| vendor | [Vendor suspension and held-parcel disposition](vendor/vendor-suspension.md) |

## Writing a feature

Copy [_TEMPLATE.md](_TEMPLATE.md) to the appropriate domain folder and adjust relative link depth. State normal, alternative, failure, cancellation, retry and terminal behavior or explain why a path does not apply. Name governing requirements and current contract definitions directly. Keep unresolved inputs explicit and preserve stable acceptance-criterion IDs.

Add the feature to this index. Link relevant surfaces and delivery scope. Update affected contracts in the same change when required; do not claim implementation until meaningful tests and the actual integrated behavior demonstrate it.
