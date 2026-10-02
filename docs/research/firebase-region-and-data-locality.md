# Firebase region and data-locality constraints

Research date: 2026-10-02. Scope: region selection for the planned collaboration functions and stores.

## Confirmed platform support

- `asia-south1` (Mumbai) is supported by **Cloud Functions for Firebase 2nd gen only**. It is therefore valid for HTTP/callable functions and 2nd-gen functions whose trigger resource is co-located there. [Firebase Functions locations](https://firebase.google.com/docs/functions/locations)
- Cloud Firestore supports a regional `asia-south1` database. A regional Firestore database is replicated across zones; Firebase documents a >=99.99% monthly SLA, versus >=99.999% for its listed multi-regions. [Firestore locations and SLA](https://firebase.google.com/docs/firestore/locations)
- Cloud Storage supports an `ASIA-SOUTH1` bucket, and a configurable India dual-region can pair `ASIA-SOUTH1` (Mumbai) with `ASIA-SOUTH2` (Delhi). [Cloud Storage bucket locations](https://cloud.google.com/storage/docs/locations)
- Firebase Realtime Database currently lists `us-central1`, `europe-west1`, and `asia-southeast1` (Singapore), **not** Mumbai. An RTDB instance location is fixed when created. [RTDB locations](https://firebase.google.com/docs/database/locations)

## Consequence for this app

The compaction function is an RTDB event trigger. Firebase says RTDB-triggered functions must match the instance location; a mismatch can create significant latency or fail deployment. For 2nd gen, the RTDB instance named in a trigger must exist in the function's region. Therefore, if the project uses the Singapore RTDB instance, the RTDB deletion/compaction function belongs in `asia-southeast1`, not Mumbai. [RTDB triggers](https://firebase.google.com/docs/functions/database-events)

The Firestore sharing-policy mirror belongs as close as possible to the Firestore database. A 2nd-gen Firestore trigger must be in the same project and is delivered at least once, with no guaranteed ordering; its handler must remain idempotent. [Firestore 2nd-gen triggers](https://firebase.google.com/docs/firestore/extend-with-functions-2nd-gen)

This means one project can legitimately use two function regions: RTDB-triggered compaction in the RTDB region, and Firestore-triggered/access callable functions in the Firestore region. Do not select one region globally merely because it is closest to users.

## Cost, latency, and durability guidance

- Co-locate a function with its trigger/data store where supported. Firebase warns that a function and database/bucket in different locations can increase latency and billing costs. [Function location guidance](https://firebase.google.com/docs/functions/locations)
- Select a Firestore location close to both users and compute; Firebase explicitly calls far-reaching hops more error-prone and higher-latency. Regional Firestore is the lower-cost/write-latency option; multi-region is the higher-availability option. [Firestore best practices](https://firebase.google.com/docs/firestore/best-practices)
- A web/mobile Firestore SDK cannot force a regional endpoint, and regional endpoints do not support real-time listeners. This is relevant if data-residency routing is later imposed: it is a server-SDK control, not a browser-listener solution. [Firestore regional endpoints](https://firebase.google.com/docs/firestore/regional-endpoints)
- RTDB's region does not set, or follow, Firestore or Storage location. Firestore, RTDB, Storage, and Functions each have their own location selection, subject only to limited legacy/default-resource dependencies. [Firebase project locations](https://firebase.google.com/docs/projects/locations), [RTDB locations](https://firebase.google.com/docs/database/locations)

## Migration constraints

- Firestore and RTDB database locations cannot be changed after provisioning. A move is a data/application migration to a new database, not a setting change. [Firestore locations](https://firebase.google.com/docs/firestore/locations), [RTDB locations](https://firebase.google.com/docs/database/locations)
- Functions are not moved in place. Firebase's safe sequence is: make the handler idempotent, deploy a renamed function in the new region, then delete the old one; overlap can yield duplicate processing. [Manage Firebase Functions](https://firebase.google.com/docs/functions/manage-functions)
- Cloud Storage now has a bucket-relocation feature, but it requires Storage Intelligence and some relocations have a final write-unavailable synchronization step. If that cannot be used, create a destination bucket and copy/transfer objects. Treat an existing storage location as a migration project, not a quick configuration edit. [Bucket relocation overview](https://cloud.google.com/storage/docs/bucket-relocation/overview), [Storage Transfer guidance](https://cloud.google.com/blog/products/storage-data-transfer/multi-region-google-cloud-storage-to-regional-data-migration)

## Required pre-deploy check

Record the actual locations of the production Firestore database, RTDB instance, and Storage bucket before changing function regions. The current source hard-codes `us-central1` for all three functions; it must not be deployed unchanged until each trigger's resource location is verified and the functions are split/co-located accordingly.
