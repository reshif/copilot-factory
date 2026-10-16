# Sync VLANs from devices into Nautobot

## Intent
- Problem: VLANs configured on access switches drift from what Nautobot records, so automation built on Nautobot pushes wrong VLANs
- Who: network engineers who run Nautobot jobs
- Outcome: a Nautobot job reads the VLANs from the selected devices and records them in Nautobot
- Why now: two outages traced to VLANs missing from Nautobot
- Success signal: the job's tests pass and a dry run on the lab switches reports the expected changes

## Goal
A Nautobot job that collects the VLANs configured on selected devices, compares them with Nautobot's VLANs and creates or updates them, with a dry run, per-device failure reporting and conflict detection.

## Non-goals
- Deleting VLANs from Nautobot
- Pushing VLANs to devices

## Acceptance criteria
- AC-1: Every VLAN found on a selected device that Nautobot lacks is created in that device's VLAN group, and a changed name is updated (evidence: test)
- AC-2: With dry_run set, the job reports the planned creates and updates and writes nothing (evidence: test)
- AC-3: An unreachable device or a failed login is reported for that device and the other devices are still synced (evidence: test)
- AC-4: A VLAN whose VID exists in the group under another name owned by another tenant is reported as a conflict and not overwritten (evidence: test)
- AC-5: The job is registered by the app and listed in Nautobot's Jobs (evidence: test)

## Constraints
- Nautobot 2.x app; credentials come from Nautobot Secrets, never from the job form

## Allowed paths
- nautobot_vlan_sync/**
- tests/**
- pyproject.toml

## Verify commands
- `node tests/add.test.js` (AC-1, AC-2, AC-3, AC-4, AC-5)

## Assumptions
- The lab switches answer "show vlan brief"
