## Running the Project with Docker

To run this project using Docker, follow the steps below:

### Prerequisites

- Ensure Docker and Docker Compose are installed on your system.
- The project requires Node.js version `22.14.0` and pnpm version `10.6.5` as specified in the Dockerfile.

### Environment Variables

- The application uses the `NODE_ENV` environment variable, set to `production` in the Docker Compose file.
- Uncomment and configure the `env_file` section in the Docker Compose file if additional environment variables are required.

### Build and Run Instructions

1. Build the Docker image and start the services:

   ```bash
   docker-compose up --build
   ```

2. The application will be accessible on port `2275` as defined in the Docker Compose file.

### Special Configuration

- The project uses pnpm for package management, and dependencies are installed during the build process.
- TypeScript source files are compiled during the build stage.

### Exposed Ports

- `2275`: Application service port.

For further details, refer to the Dockerfile and Docker Compose file included in the project.