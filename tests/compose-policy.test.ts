import { describe, expect, it } from "vitest";
import {
	composeFileProblems,
	forbiddenTraefikLabels,
} from "../src/agent/compose-policy.js";

const compose = (...lines: string[]) => lines.join("\n");
const hostDir = `$${"{HOST_DIR}"}`;

describe("compose policy", () => {
	it("accepts ordinary services, named volumes, and service-dir files", () => {
		expect(
			composeFileProblems(
				compose(
					"services:",
					"  web:",
					"    image: nginx:1.27",
					"    build: ./web",
					"    env_file: .env",
					"    volumes:",
					"      - data:/data",
					"      - ../files/nginx.conf:/etc/nginx/nginx.conf:ro",
					"      - /var/cache/nginx",
					"      - type: tmpfs",
					"        target: /tmp",
					"    labels:",
					"      - traefik.enable=true",
					"      - traefik.http.services.web.loadbalancer.server.port=8080",
					"    network_mode: service:db",
					"  db:",
					"    image: postgres:17",
					"volumes:",
					"  data: {}",
				),
			),
		).toEqual([]);
	});

	it("rejects host access and foreign volumes", () => {
		const problems = composeFileProblems(
			compose(
				"x-common: &common",
				"  privileged: true",
				"services:",
				"  root:",
				"    <<: *common",
				"    image: alpine",
				"    pid: host",
				"    network_mode: container:dokploy",
				"    cap_add: [SYS_ADMIN]",
				"    security_opt: [seccomp:unconfined]",
				"    devices: [/dev/sda]",
				"    volumes:",
				"      - /var/run/docker.sock:/var/run/docker.sock",
				"      - ../../other/files:/x",
				`      - ${hostDir}:/y`,
				"      - type: bind",
				"        source: ~/secrets",
				"        target: /z",
				"      - shared:/shared",
				"    volumes_from: [container:dokploy-postgres]",
				"    env_file: [/etc/dokploy/.env]",
				"    build:",
				"      context: /",
				"volumes:",
				"  shared:",
				"    external: true",
				"    name: dokploy-postgres",
				"  dev:",
				"    driver_opts: { type: none, o: bind, device: / }",
				"secrets:",
				"  key:",
				"    file: /root/.ssh/id_ed25519",
				"include: [../other/compose.yml]",
			),
		);
		for (const expected of [
			"compose file uses include; inline the services instead",
			"volume shared sets external",
			"volume shared sets name",
			"volume dev sets driver_opts",
			"secrets key file /root/.ssh/id_ed25519 is an absolute host path",
			"service root sets privileged",
			"service root sets cap_add",
			"service root sets security_opt",
			"service root sets devices",
			"service root sets pid: host",
			"service root sets network_mode: container:dokploy",
			"service root bind mount /var/run/docker.sock is an absolute host path",
			"service root bind mount ../../other/files leaves the service directory",
			`service root bind mount ${hostDir} uses variable interpolation`,
			"service root bind mount ~/secrets is an absolute host path",
			"service root takes volumes_from container:dokploy-postgres",
			"service root env_file /etc/dokploy/.env is an absolute host path",
			"service root build context / is an absolute host path",
		]) {
			expect(problems).toContain(expected);
		}
	});

	it("rejects undeclared volumes, router labels, and invalid YAML", () => {
		expect(
			composeFileProblems(
				compose(
					"services:",
					"  web:",
					"    image: nginx",
					"    volumes: [dokploy-postgres-database:/data]",
					"    deploy:",
					"      labels:",
					"        traefik.http.routers.x.rule: Host(`example.com`)",
				),
			),
		).toEqual([
			"service web mounts volume dokploy-postgres-database not declared in this file",
			"service web sets Traefik labels traefik.http.routers.x.rule; route through domain create",
		]);
		expect(composeFileProblems("services: [")[0]).toMatch(
			/^compose file is not valid YAML/,
		);
	});

	it("lists only router-capable Traefik labels", () => {
		expect(
			forbiddenTraefikLabels({
				"traefik.enable": "true",
				"traefik.http.services.app.loadbalancer.server.port": "80",
				"traefik.http.routers.app.rule": "Host(`example.com`)",
				"Traefik.TCP.routers.db.rule": "HostSNI(`*`)",
				"com.example.team": "web",
			}),
		).toEqual(["traefik.http.routers.app.rule", "Traefik.TCP.routers.db.rule"]);
	});
});
