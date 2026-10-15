import java.io.IOException;
import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.concurrent.TimeUnit;

/**
 * Blockhaus launcher shim.
 *
 * Crafty Controller starts a server as "java -jar <executable> nogui". Forge, NeoForge and Quilt do not
 * start that way (they need an installer run first and, for modern Forge/NeoForge, a JVM argument file).
 * Blockhaus puts this tiny jar in place of the executable. It reads blockhaus-launch.properties from the
 * working directory, runs the installer once, then starts the real server with the same JVM and the same
 * memory settings, forwarding stdin/stdout so Crafty's console and "stop" keep working.
 *
 * blockhaus-launch.properties:
 *   installer.jar=blockhaus/installer.jar        (optional)
 *   installer.args=--installServer               (space separated)
 *   installer.marker=blockhaus/installed-<id>    (file created after a successful install)
 *   launch.1=args:libraries/.../unix_args.txt    (first existing candidate wins)
 *   launch.2=jar:server-launch.jar
 */
public class Launcher {
    private static void log(String s) {
        System.out.println("[Blockhaus] " + s);
        System.out.flush();
    }

    private static int run(List<String> cmd) throws IOException, InterruptedException {
        Process p = new ProcessBuilder(cmd).inheritIO().start();
        return p.waitFor();
    }

    public static void main(String[] programArgs) throws Exception {
        Path cwd = Paths.get("").toAbsolutePath();
        Path propsFile = cwd.resolve("blockhaus-launch.properties");
        if (!Files.exists(propsFile)) {
            log("blockhaus-launch.properties fehlt in " + cwd + ". Software im Blockhaus neu installieren.");
            System.exit(2);
        }
        Properties p = new Properties();
        try (InputStream in = Files.newInputStream(propsFile)) {
            p.load(in);
        }
        String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();

        List<String> jvm = new ArrayList<String>();
        for (String a : ManagementFactory.getRuntimeMXBean().getInputArguments()) {
            if (a.startsWith("-Xm") || a.startsWith("-Xs") || a.startsWith("-XX:")) {
                jvm.add(a);
            }
        }

        String installer = p.getProperty("installer.jar");
        if (installer != null && !installer.isEmpty()) {
            Path marker = cwd.resolve(p.getProperty("installer.marker", "blockhaus/installed"));
            if (!Files.exists(marker)) {
                log("Der Installer laeuft einmalig und braucht Internet. Das kann einige Minuten dauern ...");
                List<String> cmd = new ArrayList<String>();
                cmd.add(java);
                cmd.add("-jar");
                cmd.add(installer);
                String ia = p.getProperty("installer.args", "").trim();
                if (!ia.isEmpty()) {
                    cmd.addAll(Arrays.asList(ia.split("\\s+")));
                }
                int code = run(cmd);
                if (code != 0) {
                    log("Installer fehlgeschlagen (Exit-Code " + code + "). Siehe Ausgabe oben.");
                    System.exit(code);
                }
                Files.createDirectories(marker.getParent());
                Files.write(marker, "ok".getBytes(StandardCharsets.UTF_8));
                log("Installation fertig.");
            }
        }

        List<String> cmd = new ArrayList<String>();
        cmd.add(java);
        cmd.addAll(jvm);
        boolean found = false;
        for (int i = 1; i < 50 && !found; i++) {
            String c = p.getProperty("launch." + i);
            if (c == null) {
                continue;
            }
            int colon = c.indexOf(':');
            if (colon < 0) {
                continue;
            }
            String type = c.substring(0, colon);
            String path = c.substring(colon + 1);
            if (!Files.exists(cwd.resolve(path))) {
                continue;
            }
            if ("args".equals(type)) {
                cmd.add("@" + path);
            } else {
                cmd.add("-jar");
                cmd.add(path);
            }
            found = true;
        }
        if (!found) {
            log("Keine Startdatei gefunden (launch.* in blockhaus-launch.properties). Installation pruefen.");
            System.exit(3);
        }
        cmd.addAll(Arrays.asList(programArgs));
        log("Starte: " + String.join(" ", cmd));

        final Process child = new ProcessBuilder(cmd).inheritIO().start();
        Runtime.getRuntime().addShutdownHook(new Thread() {
            @Override
            public void run() {
                if (child.isAlive()) {
                    child.destroy();
                    try {
                        if (!child.waitFor(30, TimeUnit.SECONDS)) {
                            child.destroyForcibly();
                        }
                    } catch (InterruptedException e) {
                        child.destroyForcibly();
                    }
                }
            }
        });
        System.exit(child.waitFor());
    }
}
