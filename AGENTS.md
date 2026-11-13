# Project maintenance

- Before changing this extension, read `FIGMA_IMPORTER_KNOWLEDGE_BASE.md` and follow its maintenance and validation rules.
- User instruction (2026-11-12): after each completed plugin update, synchronize the validated runtime to `D:\projectAJ\client\trunk\extensions\figma-importer-cocos` using `npm run deploy:local`. This deployment is authorized; do not ask again for the same destination and scope.
- The deployment directory must contain only `package.json`, `dist/`, `static/`, `i18n/`, `mcp-dist/`, `LICENSE`, and `THIRD-PARTY-NOTICES.txt`. Do not deploy development sources, tests, scripts, dependencies, lockfiles, or internal documentation.
- Complete the checks appropriate to the change before deploying. Do not deploy failed or incomplete builds. Verify deployment hashes with `npm run deploy:local -- -VerifyOnly`.
- Deployment may update and remove files only inside the exact extension directory above. Do not modify the Cocos project's assets, settings, user data, or other extensions. Keep backups outside the extension directory; the deployment script does this under ignored `node_modules/.local-deploy/`.
- Tell the user to fully restart Creator after deploying; do not restart or close their running editor automatically.
- User sizing requirement (2026-11-13): resize ordinary referenced Prefab instances only through root `Scale`, using the Figma instance/main-component multipliers; never write the referenced instance's UITransform width/height for this scaling. Preserve the separately requested Popup-prefix width/height adaptation rule unless the user changes it explicitly.
