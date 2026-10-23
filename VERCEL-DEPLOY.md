# Deploying this project to Vercel

This is a Vite static site. The included `vercel.json` sets the install, production build, and output directory (`dist`). No server, environment variables, or GitHub connection are required.

## Deploy from the extracted ZIP

1. Extract the ZIP so `package.json` and `vercel.json` are at the project root.
2. From that folder, run `npm ci` and `npm run build` to verify locally (optional; Vercel also runs these commands).
3. Install the Vercel CLI and run `vercel` from the project root, or create a Vercel project and upload/connect the extracted source directory using the deployment method available to your account.
4. For production from the CLI, run `vercel --prod`.

The production bundle is generated in `dist/`. Because the game uses relative asset URLs, it remains safe to serve from a Vercel deployment path.
