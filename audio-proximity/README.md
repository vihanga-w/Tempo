## Running This Project with Docker

This project provides a Docker-based setup for building and running a TypeScript Node.js application using pnpm. The Docker configuration is tailored for this project and includes multi-stage builds for efficient image size and security.

### Project-Specific Docker Requirements
- **Node.js version:** 22.14.0 (as set by `NODE_VERSION` build argument)
- **pnpm version:** 10.6.5 (as set by `PNPM_VERSION` build argument)
- **Build output:** Compiled TypeScript files are output to the `./build` directory
- **Non-root user:** The production container runs as a non-root `appuser` for improved security

### Environment Variables
- No required environment variables are specified in the Dockerfiles or `docker-compose.yml` by default.
- If you need to provide environment variables, you can create a `.env` file and uncomment the `env_file: ./.env` line in the compose file.

### Build and Run Instructions
1. **Build and start the service:**
   ```sh
   docker compose up --build
   ```
   This will build the image using the specified Node.js and pnpm versions, install dependencies, compile TypeScript, and start the app.

2. **Accessing the application:**
   - The service `typescript-app` exposes port **7733**. The app will be available on `localhost:7733` by default.

### Special Configuration
- If you add external dependencies (e.g., databases), update the `docker-compose.yml` to include them and use `depends_on` as needed.
- The build process uses Docker cache mounts for faster dependency installation.
- Only the necessary files (`package.json`, `node_modules`, `build`, and `static`) are included in the final image for efficiency and security.

### Ports
- **typescript-app:** Exposes port **7733** (mapped to host port 7733)

---

_If you update dependencies or add new services, update the Docker and Compose files accordingly to ensure a smooth build and deployment process._
