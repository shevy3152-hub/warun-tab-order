import javax.swing.BorderFactory;
import javax.swing.JButton;
import javax.swing.JFileChooser;
import javax.swing.JFrame;
import javax.swing.JLabel;
import javax.swing.JPanel;
import javax.swing.JPasswordField;
import javax.swing.JScrollPane;
import javax.swing.JTextArea;
import javax.swing.JTextField;
import javax.swing.SwingUtilities;
import javax.swing.SwingWorker;
import java.awt.BorderLayout;
import java.awt.Desktop;
import java.awt.Dimension;
import java.awt.GridBagConstraints;
import java.awt.GridBagLayout;
import java.awt.GridLayout;
import java.awt.Insets;
import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.channels.OverlappingFileLockException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ReleaseBuilderGui extends JFrame {
    private static final String APPLICATION_ID = "jp.co.warun.androidkiosk";
    private static final int VERSION_CODE = 3;
    private static final String VERSION_NAME = "1.0.1";
    private static final String STORE_ENV = "WARUN_KIOSK_GUI_STOREPASS";
    private static final String KEY_ENV = "WARUN_KIOSK_GUI_KEYPASS";
    private static FileChannel instanceChannel;
    private static FileLock instanceLock;

    private final Path repoRoot;
    private final Path androidRoot;
    private final Path readinessMarker;
    private final JTextField keystorePathField = new JTextField();
    private final JTextField aliasField = new JTextField("warun-kiosk");
    private final JPasswordField storePasswordField = new JPasswordField();
    private final JPasswordField storeConfirmField = new JPasswordField();
    private final JPasswordField keyPasswordField = new JPasswordField();
    private final JPasswordField keyConfirmField = new JPasswordField();
    private final JButton browseButton = new JButton("参照");
    private final JButton createButton = new JButton("keystoreを作成");
    private final JButton buildButton = new JButton("本番APKを作成");
    private final JButton verifyButton = new JButton("既存APKを検証");
    private final JButton openButton = new JButton("保存先を開く");
    private final JButton closeButton = new JButton("閉じる");
    private final JTextArea logArea = new JTextArea();
    private final JTextField apkPathField = resultField();
    private final JTextField apkHashField = resultField();
    private final JTextField certificateHashField = resultField();
    private final JTextField keystoreHashField = resultField();
    private SwingWorker<?, ?> activeWorker;
    private Path lastApk;

    public ReleaseBuilderGui(Path root) {
        this(root, null);
    }

    public ReleaseBuilderGui(Path root, Path marker) {
        super("わるん キオスク本番APK作成");
        repoRoot = root.toAbsolutePath().normalize();
        androidRoot = repoRoot.resolve("android-kiosk").normalize();
        readinessMarker = marker == null ? null : marker.toAbsolutePath().normalize();
        setDefaultCloseOperation(DO_NOTHING_ON_CLOSE);
        setMinimumSize(new Dimension(760, 650));
        setContentPane(createContent());
        pack();
        setSize(new Dimension(900, 760));
        setLocationByPlatform(true);
        keystorePathField.setText(defaultKeystorePath());
        openButton.setEnabled(false);
        closeButton.addActionListener(event -> closeWindow());
        browseButton.addActionListener(event -> chooseKeystore());
        createButton.addActionListener(event -> createKeystore());
        buildButton.addActionListener(event -> buildRelease());
        verifyButton.addActionListener(event -> verifyExistingRelease());
        openButton.addActionListener(event -> openOutputFolder());
        addWindowListener(new WindowAdapter() {
            @Override
            public void windowClosing(WindowEvent event) {
                closeWindow();
            }
        });
    }

    public static void main(String[] args) {
        if (args.length > 0 && "--self-test".equals(args[0])) {
            System.exit(runSelfTest(args.length > 1 ? Paths.get(args[1]) : Paths.get(".")));
        }
        Path root = args.length == 0 ? Paths.get(".") : Paths.get(args[0]);
        Path marker = args.length > 1 ? Paths.get(args[1]) : null;
        SwingUtilities.invokeLater(() -> {
            ReleaseBuilderGui gui = new ReleaseBuilderGui(root, marker);
            gui.setVisible(true);
            gui.writeReadinessMarker();
        });
    }

    private static boolean acquireSingleInstance() {
        try {
            Path lockPath = Paths.get(System.getProperty("java.io.tmpdir"),
                    "warun-kiosk-release-builder.lock");
            instanceChannel = FileChannel.open(lockPath,
                    java.nio.file.StandardOpenOption.CREATE,
                    java.nio.file.StandardOpenOption.WRITE);
            instanceLock = instanceChannel.tryLock();
            if (instanceLock != null) return true;
        } catch (OverlappingFileLockException | IOException ignored) {
            // Treat an existing or unavailable lock as an already-running instance.
        }
        closeInstanceLock();
        return false;
    }

    private static void closeInstanceLock() {
        try {
            if (instanceLock != null) instanceLock.release();
        } catch (IOException ignored) {
            // Best-effort cleanup only.
        } finally {
            instanceLock = null;
            try {
                if (instanceChannel != null) instanceChannel.close();
            } catch (IOException ignored) {
                // Best-effort cleanup only.
            } finally {
                instanceChannel = null;
            }
        }
    }

    private static int runSelfTest(Path root) {
        Path repo = root.toAbsolutePath().normalize();
        Path android = repo.resolve("android-kiosk");
        Path wrapper = android.resolve("gradlew.bat");
        Path sdk = resolveSdkRoot(android);
        boolean javaOk = Files.isRegularFile(Paths.get(System.getProperty("java.home"), "bin", "java.exe"));
        boolean sdkOk = sdk != null;
        boolean wrapperOk = Files.isRegularFile(wrapper);
        System.out.println("repo=" + repo);
        System.out.println("java.home=" + System.getProperty("java.home"));
        System.out.println("java=" + (javaOk ? "ok" : "missing"));
        System.out.println("sdk=" + (sdkOk ? sdk : "missing"));
        System.out.println("gradlew.bat=" + (wrapperOk ? "ok" : "missing"));
        return javaOk && sdkOk && wrapperOk ? 0 : 1;
    }

    private JPanel createContent() {
        JPanel root = new JPanel(new BorderLayout(8, 8));
        root.setBorder(BorderFactory.createEmptyBorder(10, 10, 10, 10));
        JPanel form = new JPanel(new GridBagLayout());
        GridBagConstraints c = new GridBagConstraints();
        c.insets = new Insets(3, 3, 3, 3);
        c.anchor = GridBagConstraints.LINE_START;
        c.fill = GridBagConstraints.HORIZONTAL;
        addRow(form, c, 0, "keystore保存先", keystorePathField, browseButton);
        addRow(form, c, 1, "alias", aliasField, null);
        addRow(form, c, 2, "keystore password", storePasswordField, null);
        addRow(form, c, 3, "password確認", storeConfirmField, null);
        addRow(form, c, 4, "key password", keyPasswordField, null);
        addRow(form, c, 5, "key password確認", keyConfirmField, null);
        JPanel actions = new JPanel(new GridLayout(1, 3, 6, 0));
        actions.add(createButton);
        actions.add(buildButton);
        actions.add(verifyButton);
        c.gridx = 1;
        c.gridy = 6;
        c.gridwidth = 2;
        c.weightx = 1;
        form.add(actions, c);
        root.add(form, BorderLayout.NORTH);

        logArea.setEditable(false);
        logArea.setLineWrap(true);
        logArea.setWrapStyleWord(true);
        logArea.setRows(12);
        JPanel progress = new JPanel(new BorderLayout(4, 4));
        progress.setBorder(BorderFactory.createTitledBorder("進行状況・結果"));
        progress.add(new JScrollPane(logArea), BorderLayout.CENTER);
        root.add(progress, BorderLayout.CENTER);

        JPanel results = new JPanel(new GridBagLayout());
        GridBagConstraints r = new GridBagConstraints();
        r.insets = new Insets(2, 3, 2, 3);
        r.anchor = GridBagConstraints.LINE_START;
        r.fill = GridBagConstraints.HORIZONTAL;
        addResultRow(results, r, 0, "APK保存先", apkPathField);
        addResultRow(results, r, 1, "APK SHA-256", apkHashField);
        addResultRow(results, r, 2, "署名証明書 SHA-256", certificateHashField);
        addResultRow(results, r, 3, "keystore SHA-256", keystoreHashField);
        JPanel bottom = new JPanel(new BorderLayout(6, 0));
        bottom.add(results, BorderLayout.CENTER);
        JPanel bottomButtons = new JPanel(new GridLayout(1, 2, 6, 0));
        bottomButtons.add(openButton);
        bottomButtons.add(closeButton);
        bottom.add(bottomButtons, BorderLayout.SOUTH);
        root.add(bottom, BorderLayout.SOUTH);
        return root;
    }

    private static JTextField resultField() {
        JTextField field = new JTextField();
        field.setEditable(false);
        return field;
    }

    private static void addRow(JPanel panel, GridBagConstraints c, int row, String label,
                               JTextField field, JButton sideButton) {
        c.gridy = row;
        c.gridx = 0;
        c.gridwidth = 1;
        c.weightx = 0;
        panel.add(new JLabel(label), c);
        c.gridx = 1;
        c.weightx = 1;
        panel.add(field, c);
        if (sideButton != null) {
            c.gridx = 2;
            c.weightx = 0;
            panel.add(sideButton, c);
        }
    }

    private static void addResultRow(JPanel panel, GridBagConstraints c, int row,
                                     String label, JTextField field) {
        c.gridy = row;
        c.gridx = 0;
        c.weightx = 0;
        panel.add(new JLabel(label), c);
        c.gridx = 1;
        c.weightx = 1;
        panel.add(field, c);
    }

    private String defaultKeystorePath() {
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData == null || localAppData.trim().isEmpty()) {
            localAppData = System.getProperty("user.home");
        }
        return Paths.get(localAppData, "Warun", "signing", "warun-kiosk-release.jks")
                .toAbsolutePath().normalize().toString();
    }

    private void chooseKeystore() {
        JFileChooser chooser = new JFileChooser();
        chooser.setDialogTitle("release keystore保存先");
        chooser.setSelectedFile(new File(keystorePathField.getText().trim()));
        if (chooser.showSaveDialog(this) == JFileChooser.APPROVE_OPTION) {
            keystorePathField.setText(chooser.getSelectedFile().getAbsolutePath());
        }
    }

    private void createKeystore() {
        Credentials credentials = credentialsFromFields();
        if (credentials == null) return;
        Path path;
        try {
            path = checkedKeystorePath();
            if (Files.exists(path)) {
                throw new UserVisibleException("既存keystoreは上書きしません。別の保存先を指定してください。");
            }
        } catch (Exception error) {
            credentials.clear();
            clearPasswordFields();
            showError(userMessage(error));
            return;
        }
        setBusy(true);
        log("keystore作成を開始しました。パスワードは表示しません。");
        activeWorker = new SwingWorker<KeystoreResult, Void>() {
            @Override
            protected KeystoreResult doInBackground() throws Exception {
                try {
                    return createAndVerifyKeystore(path, credentials.alias,
                            credentials.storePassword, credentials.keyPassword);
                } finally {
                    credentials.clear();
                }
            }

            @Override
            protected void done() {
                clearPasswordFields();
                setBusy(false);
                try {
                    KeystoreResult result = get();
                    log("keystore作成とalias・鍵種別・有効期限の検証に成功しました。");
                    keystoreHashField.setText(result.fileHash);
                    showInfo("keystoreを作成しました。次に本番APKを作成できます。");
                } catch (Exception error) {
                    log("keystore作成に失敗しました。");
                    showError(userMessage(error));
                }
            }
        };
        activeWorker.execute();
    }

    private void buildRelease() {
        Credentials credentials = credentialsFromFields();
        if (credentials == null) return;
        Path path;
        try {
            path = checkedKeystorePath();
            if (!Files.isRegularFile(path)) {
                throw new UserVisibleException("指定されたkeystoreが見つかりません。");
            }
        } catch (Exception error) {
            credentials.clear();
            clearPasswordFields();
            showError(userMessage(error));
            return;
        }
        setBusy(true);
        clearResults();
        log("本番APK buildを開始しました。GUIは操作可能なままです。");
        activeWorker = new SwingWorker<ApkResult, String>() {
            @Override
            protected ApkResult doInBackground() throws Exception {
                try {
                    Map<String, String> environment = new HashMap<>();
                    try {
                        environment.put("WARUN_KIOSK_KEYSTORE_FILE", path.toString());
                        environment.put("WARUN_KIOSK_KEYSTORE_PASSWORD", new String(credentials.storePassword));
                        environment.put("WARUN_KIOSK_KEY_ALIAS", credentials.alias);
                        environment.put("WARUN_KIOSK_KEY_PASSWORD", new String(credentials.keyPassword));
                        String[] tasks = {"testDebugUnitTest", "lintRelease", "assembleRelease"};
                        for (String task : tasks) {
                            publish(task + "を実行中...");
                            ProcessResult result = runGradle(task, environment);
                            if (result.exitCode != 0) {
                                throw new UserVisibleException(task + "に失敗しました。署名値や詳細ログは表示しません。");
                            }
                            publish(task + " PASS");
                        }
                        publish("APK署名とapplicationId・version・debuggableを検証中...");
                        return verifyReleaseApk(path);
                    } finally {
                        environment.clear();
                    }
                } finally {
                    credentials.clear();
                }
            }

            @Override
            protected void process(List<String> messages) {
                for (String message : messages) log(message);
            }

            @Override
            protected void done() {
                clearPasswordFields();
                setBusy(false);
                try {
                    ApkResult result = get();
                    lastApk = result.apk;
                    apkPathField.setText(result.apk.toString());
                    apkHashField.setText(result.apkHash);
                    certificateHashField.setText(result.certificateHash);
                    keystoreHashField.setText(result.keystoreHash);
                    openButton.setEnabled(true);
                    log("本番APK build、署名検証、artifact情報確認が完了しました。");
                    showInfo("本番APKを作成しました。A90への自動installは行っていません。");
                } catch (Exception error) {
                    log("本番APK buildに失敗しました。APKの自動適用は行っていません。");
                    showError(userMessage(error));
                }
            }
        };
        activeWorker.execute();
    }

    private void verifyExistingRelease() {
        Path path;
        try {
            path = checkedKeystorePath();
            if (!Files.isRegularFile(path)) {
                throw new UserVisibleException("指定されたkeystoreが見つかりません。");
            }
        } catch (Exception error) {
            showError(userMessage(error));
            return;
        }
        setBusy(true);
        clearResults();
        log("既存release APKの署名とartifact情報を検証中です。passwordは使用しません。");
        activeWorker = new SwingWorker<ApkResult, Void>() {
            @Override
            protected ApkResult doInBackground() throws Exception {
                return verifyReleaseApk(path);
            }

            @Override
            protected void done() {
                clearPasswordFields();
                setBusy(false);
                try {
                    ApkResult result = get();
                    lastApk = result.apk;
                    apkPathField.setText(result.apk.toString());
                    apkHashField.setText(result.apkHash);
                    certificateHashField.setText(result.certificateHash);
                    keystoreHashField.setText(result.keystoreHash);
                    openButton.setEnabled(true);
                    log("既存release APKの署名検証とartifact情報確認が完了しました。");
                    showInfo("既存release APKを検証しました。buildとpassword入力は行っていません。");
                } catch (Exception error) {
                    log("既存release APKの検証に失敗しました。");
                    showError(userMessage(error));
                }
            }
        };
        activeWorker.execute();
    }

    private Credentials credentialsFromFields() {
        char[] store = storePasswordField.getPassword();
        char[] storeConfirm = storeConfirmField.getPassword();
        char[] key = keyPasswordField.getPassword();
        char[] keyConfirm = keyConfirmField.getPassword();
        String alias = aliasField.getText().trim();
        String error = null;
        if (store.length < 14 || key.length < 14) {
            error = "passwordはそれぞれ14文字以上で入力してください。";
        } else if (!Arrays.equals(store, storeConfirm) || !Arrays.equals(key, keyConfirm)) {
            error = "password確認が一致しません。";
        } else if (alias.isEmpty()) {
            error = "aliasを入力してください。";
        }
        Arrays.fill(storeConfirm, '\0');
        Arrays.fill(keyConfirm, '\0');
        if (error != null) {
            Arrays.fill(store, '\0');
            Arrays.fill(key, '\0');
            showError(error);
            return null;
        }
        return new Credentials(alias, store, key);
    }

    private Path checkedKeystorePath() throws IOException, UserVisibleException {
        String value = keystorePathField.getText().trim();
        if (value.isEmpty()) throw new UserVisibleException("keystore保存先を指定してください。");
        Path path = Paths.get(value).toAbsolutePath().normalize();
        Path root = repoRoot.toAbsolutePath().normalize();
        if (path.equals(root) || path.startsWith(root)) {
            throw new UserVisibleException("安全のためrepo配下にはkeystoreを保存できません。");
        }
        return path;
    }

    private KeystoreResult createAndVerifyKeystore(Path path, String alias,
                                                    char[] storePassword,
                                                    char[] keyPassword) throws Exception {
        Files.createDirectories(path.getParent());
        Map<String, String> environment = secretEnvironment(storePassword, keyPassword);
        List<String> args = Arrays.asList(
                "-J-Duser.language=en", "-J-Duser.country=US", "-genkeypair",
                "-keystore", path.toString(), "-storetype", "JKS", "-alias", alias,
                "-keyalg", "RSA", "-keysize", "4096", "-validity", "10000",
                "-dname", "CN=Warun Kiosk Release, OU=Warun, O=Warun, C=JP",
                "-storepass:env", STORE_ENV, "-keypass:env", KEY_ENV);
        try {
            ProcessResult created = runExecutable(findKeytool(), args, environment);
            if (created.exitCode != 0) {
                throw new UserVisibleException("keystore作成に失敗しました。既存ファイルは上書きしていません。");
            }
            return verifyKeystore(path, alias, environment);
        } finally {
            environment.clear();
        }
    }

    private KeystoreResult verifyKeystore(Path path, String alias,
                                           Map<String, String> environment) throws Exception {
        List<String> args = Arrays.asList(
                "-J-Duser.language=en", "-J-Duser.country=US", "-list", "-v",
                "-keystore", path.toString(), "-alias", alias,
                "-storepass:env", STORE_ENV);
        ProcessResult result = runExecutable(findKeytool(), args, environment);
        if (result.exitCode != 0 || !result.output.contains("Alias name: " + alias)
                || !result.output.contains("PrivateKeyEntry")
                || !result.output.matches("(?s).*RSA.*4096.*")
                || !result.output.contains("Valid from:")) {
            throw new UserVisibleException("keystoreのalias・鍵種別・有効期限を検証できませんでした。");
        }
        return new KeystoreResult(sha256(path));
    }

    private ApkResult verifyReleaseApk(Path keystore) throws Exception {
        Path outputDirectory = androidRoot.resolve("app/build/outputs/apk/release");
        if (!Files.isDirectory(outputDirectory)) throw new UserVisibleException("release APKが見つかりません。");
        Path apk;
        try (java.util.stream.Stream<Path> files = Files.list(outputDirectory)) {
            apk = files.filter(file -> file.getFileName().toString().endsWith(".apk"))
                    .max(Comparator.comparingLong(this::lastModified))
                    .orElseThrow(() -> new UserVisibleException("release APKが見つかりません。"));
        }
        Path apksigner = findSdkTool("apksigner.bat");
        Path aapt2 = findSdkTool("aapt2.exe");
        Map<String, String> verificationEnvironment = new HashMap<>();
        String javaHome = System.getProperty("java.home");
        if (javaHome == null || javaHome.trim().isEmpty()
                || !Files.isRegularFile(Paths.get(javaHome, "bin", "java.exe"))) {
            throw new UserVisibleException("起動中のJavaからJAVA_HOMEを解決できません。");
        }
        verificationEnvironment.put("JAVA_HOME", javaHome);
        ProcessResult signature = runBatch(apksigner,
                Arrays.asList("verify", "--verbose", "--print-certs", apk.toString()),
                verificationEnvironment);
        if (signature.exitCode != 0) throw new UserVisibleException("APK署名検証に失敗しました。");
        Matcher cert = Pattern.compile("Signer #1 certificate SHA-256 digest: (.+)")
                .matcher(signature.output);
        if (!cert.find()) throw new UserVisibleException("署名証明書SHA-256を取得できませんでした。");
        String certificateHash = cert.group(1).trim();

        ProcessResult badging = runExecutable(aapt2,
                Arrays.asList("dump", "badging", apk.toString()), new HashMap<>());
        if (badging.exitCode != 0) throw new UserVisibleException("APK metadata検証に失敗しました。");
        Matcher packageLine = Pattern.compile(
                "package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'"
        ).matcher(badging.output);
        if (!packageLine.find() || !APPLICATION_ID.equals(packageLine.group(1))
                || !String.valueOf(VERSION_CODE).equals(packageLine.group(2))
                || !VERSION_NAME.equals(packageLine.group(3))
                || badging.output.contains("application-debuggable")) {
            throw new UserVisibleException("applicationId・version・debuggableの検証に失敗しました。");
        }
        return new ApkResult(apk, sha256(apk), certificateHash, sha256(keystore));
    }

    private Map<String, String> secretEnvironment(char[] storePassword, char[] keyPassword) {
        Map<String, String> environment = new HashMap<>();
        environment.put(STORE_ENV, new String(storePassword));
        environment.put(KEY_ENV, new String(keyPassword));
        return environment;
    }

    private ProcessResult runGradle(String task, Map<String, String> environment) throws Exception {
        Path gradlew = androidRoot.resolve("gradlew.bat");
        if (!Files.isRegularFile(gradlew)) throw new UserVisibleException("Gradle Wrapperが見つかりません。");
        Map<String, String> gradleEnvironment = new HashMap<>(environment);
        String javaHome = System.getProperty("java.home");
        if (javaHome == null || javaHome.trim().isEmpty()
                || !Files.isRegularFile(Paths.get(javaHome, "bin", "java.exe"))) {
            throw new UserVisibleException("起動中のJavaからJAVA_HOMEを解決できません。");
        }
        gradleEnvironment.put("JAVA_HOME", javaHome);
        Path sdkRoot = resolveSdkRoot(androidRoot);
        if (sdkRoot == null) {
            throw new UserVisibleException("Android SDKを解決できません。local.propertiesまたはAndroid SDK設定を確認してください。");
        }
        gradleEnvironment.put("ANDROID_SDK_ROOT", sdkRoot.toString());
        gradleEnvironment.put("ANDROID_HOME", sdkRoot.toString());
        return runBatch(gradlew, Arrays.asList(task, "--no-daemon"), gradleEnvironment);
    }

    private ProcessResult runBatch(Path batch, List<String> args,
                                   Map<String, String> environment) throws Exception {
        StringBuilder command = new StringBuilder("\"").append(batch).append("\"");
        for (String arg : args) command.append(' ').append('"').append(arg).append('"');
        String commandLine = "\"" + command + "\"";
        return runProcess(Arrays.asList(findComSpec(), "/d", "/c", commandLine), environment);
    }

    private ProcessResult runExecutable(Path executable, List<String> args,
                                        Map<String, String> environment) throws Exception {
        List<String> command = new ArrayList<>();
        command.add(executable.toString());
        command.addAll(args);
        return runProcess(command, environment);
    }

    private ProcessResult runProcess(List<String> command,
                                     Map<String, String> environment) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(androidRoot.toFile());
        builder.redirectErrorStream(true);
        for (Map.Entry<String, String> entry : environment.entrySet()) {
            builder.environment().put(entry.getKey(), entry.getValue());
        }
        Process process = builder.start();
        for (String name : environment.keySet()) builder.environment().remove(name);
        StringBuilder output = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) output.append(line).append('\n');
        }
        return new ProcessResult(process.waitFor(), output.toString());
    }

    private Path findKeytool() throws UserVisibleException {
        List<String> homes = Arrays.asList(System.getenv("JAVA_HOME"), System.getProperty("java.home"));
        for (String home : homes) {
            if (home == null) continue;
            Path candidate = Paths.get(home, "bin", "keytool.exe");
            if (Files.isRegularFile(candidate)) return candidate;
        }
        Path fromPath = findOnPath("keytool.exe");
        if (fromPath != null) return fromPath;
        throw new UserVisibleException("keytoolが見つかりません。JAVA_HOMEまたはJDKのPATHを確認してください。");
    }

    private Path findSdkTool(String tool) throws UserVisibleException {
        Path sdkRoot = resolveSdkRoot(androidRoot);
        if (sdkRoot == null) throw new UserVisibleException("Android SDKを解決できません。");
        List<String> roots = Arrays.asList(sdkRoot.toString());
        List<Path> candidates = new ArrayList<>();
        for (String root : roots) {
            if (root == null) continue;
            Path buildTools = Paths.get(root, "build-tools");
            if (!Files.isDirectory(buildTools)) continue;
            try (java.util.stream.Stream<Path> versions = Files.list(buildTools)) {
                versions.filter(Files::isDirectory).forEach(version -> {
                    Path candidate = version.resolve(tool);
                    if (Files.isRegularFile(candidate)) candidates.add(candidate);
                });
            } catch (IOException ignored) {
                // Try the next SDK root without exposing filesystem details.
            }
        }
        return candidates.stream().max(Comparator.comparing(Path::toString))
                .orElseThrow(() -> new UserVisibleException(tool + "が見つかりません。Android SDKを確認してください。"));
    }

    private static Path resolveSdkRoot(Path androidRoot) {
        List<Path> candidates = new ArrayList<>();
        Path localProperties = androidRoot.resolve("local.properties");
        if (Files.isRegularFile(localProperties)) {
            Properties properties = new Properties();
            try (java.io.Reader reader = Files.newBufferedReader(localProperties,
                    StandardCharsets.ISO_8859_1)) {
                properties.load(reader);
                addPathCandidate(candidates, properties.getProperty("sdk.dir"));
            } catch (IOException ignored) {
                // Continue with environment and standard locations.
            }
        }
        addPathCandidate(candidates, System.getenv("ANDROID_SDK_ROOT"));
        addPathCandidate(candidates, System.getenv("ANDROID_HOME"));
        String localAppData = System.getenv("LOCALAPPDATA");
        if (localAppData != null && !localAppData.trim().isEmpty()) {
            candidates.add(Paths.get(localAppData, "Android", "Sdk"));
        }
        String userProfile = System.getenv("USERPROFILE");
        if (userProfile != null && !userProfile.trim().isEmpty()) {
            candidates.add(Paths.get(userProfile, "AppData", "Local", "Android", "Sdk"));
        }
        for (Path candidate : candidates) {
            if (candidate != null && Files.isDirectory(candidate)) {
                return candidate.toAbsolutePath().normalize();
            }
        }
        return null;
    }

    private static void addPathCandidate(List<Path> candidates, String value) {
        if (value != null && !value.trim().isEmpty()) candidates.add(Paths.get(value));
    }

    private Path findOnPath(String executable) {
        String path = System.getenv("PATH");
        if (path == null) return null;
        for (String entry : path.split(Pattern.quote(File.pathSeparator))) {
            if (entry == null || entry.isEmpty()) continue;
            Path candidate = Paths.get(entry, executable);
            if (Files.isRegularFile(candidate)) return candidate;
        }
        return null;
    }

    private String joinEnv(String name, String... parts) {
        String root = System.getenv(name);
        if (root == null || root.trim().isEmpty()) return null;
        Path path = Paths.get(root);
        for (String part : parts) path = path.resolve(part);
        return path.toString();
    }

    private String findComSpec() {
        String value = System.getenv("ComSpec");
        return value == null || value.isEmpty() ? "cmd.exe" : value;
    }

    private long lastModified(Path path) {
        try {
            return Files.getLastModifiedTime(path).toMillis();
        } catch (IOException ignored) {
            return 0L;
        }
    }

    private String sha256(Path path) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (java.io.InputStream input = Files.newInputStream(path)) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) >= 0) {
                if (count > 0) digest.update(buffer, 0, count);
            }
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) result.append(String.format("%02x", value));
        return result.toString();
    }

    private void clearResults() {
        apkPathField.setText("");
        apkHashField.setText("");
        certificateHashField.setText("");
        keystoreHashField.setText("");
        lastApk = null;
        openButton.setEnabled(false);
    }

    private void openOutputFolder() {
        if (lastApk == null) return;
        try {
            if (!Desktop.isDesktopSupported()) throw new IOException();
            Desktop.getDesktop().open(lastApk.getParent().toFile());
        } catch (Exception error) {
            showError("保存先を開けませんでした。APK保存先を確認してください。");
        }
    }

    private void setBusy(boolean busy) {
        browseButton.setEnabled(!busy);
        createButton.setEnabled(!busy);
        buildButton.setEnabled(!busy);
        verifyButton.setEnabled(!busy);
        closeButton.setEnabled(!busy);
    }

    private void clearPasswordFields() {
        storePasswordField.setText("");
        storeConfirmField.setText("");
        keyPasswordField.setText("");
        keyConfirmField.setText("");
    }

    private void closeWindow() {
        if (activeWorker != null && !activeWorker.isDone()) return;
        clearPasswordFields();
        dispose();
        deleteReadinessMarker();
        closeInstanceLock();
    }

    private void writeReadinessMarker() {
        if (readinessMarker == null) return;
        try {
            Files.createDirectories(readinessMarker.getParent());
            Files.writeString(readinessMarker, "ready\n", StandardCharsets.UTF_8);
        } catch (IOException ignored) {
            // The GUI remains usable even if the launcher cannot observe readiness.
        }
    }

    private void deleteReadinessMarker() {
        if (readinessMarker == null) return;
        try {
            Files.deleteIfExists(readinessMarker);
        } catch (IOException ignored) {
            // Best-effort cleanup only.
        }
    }

    private void log(String message) {
        logArea.append(message + "\n");
        logArea.setCaretPosition(logArea.getDocument().getLength());
    }

    private void showInfo(String message) {
        javax.swing.JOptionPane.showMessageDialog(this, message,
                "わるん キオスク本番APK作成", javax.swing.JOptionPane.INFORMATION_MESSAGE);
    }

    private void showError(String message) {
        javax.swing.JOptionPane.showMessageDialog(this, message,
                "わるん キオスク本番APK作成", javax.swing.JOptionPane.ERROR_MESSAGE);
    }

    private String userMessage(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && !(cause instanceof UserVisibleException)) {
            cause = cause.getCause();
        }
        if (cause instanceof UserVisibleException) return cause.getMessage();
        return "処理に失敗しました。パスワードや内部詳細は表示していません。";
    }

    private static final class Credentials {
        final String alias;
        final char[] storePassword;
        final char[] keyPassword;

        Credentials(String alias, char[] storePassword, char[] keyPassword) {
            this.alias = alias;
            this.storePassword = storePassword;
            this.keyPassword = keyPassword;
        }

        void clear() {
            Arrays.fill(storePassword, '\0');
            Arrays.fill(keyPassword, '\0');
        }
    }

    private static final class ProcessResult {
        final int exitCode;
        final String output;

        ProcessResult(int exitCode, String output) {
            this.exitCode = exitCode;
            this.output = output;
        }
    }

    private static final class KeystoreResult {
        final String fileHash;

        KeystoreResult(String fileHash) {
            this.fileHash = fileHash;
        }
    }

    private static final class ApkResult {
        final Path apk;
        final String apkHash;
        final String certificateHash;
        final String keystoreHash;

        ApkResult(Path apk, String apkHash, String certificateHash, String keystoreHash) {
            this.apk = apk;
            this.apkHash = apkHash;
            this.certificateHash = certificateHash;
            this.keystoreHash = keystoreHash;
        }
    }

    private static final class UserVisibleException extends Exception {
        UserVisibleException(String message) {
            super(message);
        }
    }
}
