#!/bin/bash
# Rebuild all KDNA domains as v2 containers and publish to GitHub Releases
set -e

OPEN_DIR="/Users/AI/K/OPEN"
WORK_DIR="/tmp/kdna-v2-rebuild"
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

DOMAINS=(
  "kdna-agent_safety:agent_safety:0.7.6:Agent safety judgment domain"
  "kdna-writing:writing:0.7.3:Writing and editorial judgment domain"
  "kdna-prompt_diagnosis:prompt_diagnosis:0.7.6:Prompt diagnosis and improvement domain"
  "kdna-authoring:kdna_authoring:0.7.7:KDNA authoring judgment domain"
  "kdna-code_review:code_review:0.7.6:Code review judgment domain"
  "kdna-requirement_alignment:requirement_alignment:0.1.0:Requirement alignment judgment domain"
)

for entry in "${DOMAINS[@]}"; do
  IFS=':' read -r repo_dir domain_id version desc <<< "$entry"
  repo="aikdna/$repo_dir"
  src="$OPEN_DIR/$repo_dir"
  kdna_file="$WORK_DIR/${domain_id}-${version}.kdna"
  tag="v${version}"

  echo ""
  echo "=== Building $domain_id v$version ==="

  # Build v2 container
  cd "$OPEN_DIR/kdna-cli"
  node -e "
    const { packV2 } = require('./src/dev-pack-v2');
    const fs = require('fs');
    const path = require('path');
    const src = '$src';
    const out = '$kdna_file';
    const domain = '$domain_id';

    const manifest = {
      name: '@aikdna/$domain_id',
      version: '$version',
      description: '$desc',
    };
    if (fs.existsSync(path.join(src, 'kdna.json'))) {
      Object.assign(manifest, JSON.parse(fs.readFileSync(path.join(src, 'kdna.json'), 'utf8')));
    }
    const result = packV2(src, manifest);
    
    // Build ZIP container
    const { buildZip } = require('./src/cmds/protect');
    const zip = buildZip(result.entries);
    fs.writeFileSync(out, zip);
    console.log('Built: ' + out + ' (' + zip.length + ' bytes)');
    console.log('Payload digest: ' + result.manifest.container.payload_digest);
    console.log('Source tree digest: ' + result.payload.integrity.source_tree_digest);
  " 2>&1

  if [ ! -f "$kdna_file" ]; then
    echo "ERROR: Failed to build $kdna_file"
    exit 1
  fi

  # Create GitHub Release with asset
  echo "Uploading to $repo..."
  gh release create "$tag" \
    --repo "$repo" \
    --title "$domain_id v$version — KDNA Container v2" \
    --notes "Rebuilt as KDNA Container v2 (CBOR payload). V1 format is deprecated." \
    "$kdna_file" 2>&1 || echo "Release may already exist, uploading asset..."

  # Upload asset if release exists
  gh release upload "$tag" "$kdna_file" --repo "$repo" --clobber 2>&1 || true

  echo "=== Done: $domain_id v$version ==="
done

echo ""
echo "All domains rebuilt. Next: update registry/domains.json with new digests."
