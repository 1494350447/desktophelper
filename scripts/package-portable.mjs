import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const product = pkg.productName ?? "Desktophelper";
const version = pkg.version ?? "0.0.0";
const stageName = `${product}-${version}-win-x64`;
const zipPath = join(root, "dist", `${stageName}.zip`);
const portablePath = join(root, "dist", `${product}-Portable-${version}.exe`);
const buildDir = join(root, "work", "portable-build");
const csc = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

async function sha256(file) {
  const hash = createHash("sha256");
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", resolvePromise);
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

function makeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0;
  entry[1] = 0;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

function launcherSource(buildId) {
  const fileVersion = version.split(".").concat(["0", "0", "0"]).slice(0, 4).join(".");
  return `using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("${product}")]
[assembly: AssemblyDescription("${product} portable launcher")]
[assembly: AssemblyProduct("${product}")]
[assembly: AssemblyCompany("${product}")]
[assembly: AssemblyFileVersion("${fileVersion}")]
[assembly: AssemblyVersion("${fileVersion}")]

internal static class Program
{
    private const string AppVersion = "${version}";
    private const string BuildId = "${buildId}";
    private const string PayloadRoot = "${stageName}";
    private const string Marker = "DHZIP001";

    [STAThread]
    private static void Main()
    {
        try
        {
            string self = Application.ExecutablePath;
            long fileLength = new FileInfo(self).Length;
            long payloadLength;
            long payloadOffset;
            using (FileStream fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (fileLength < 24) throw new InvalidDataException("安装包不完整。");
                fs.Seek(-16, SeekOrigin.End);
                byte[] tail = new byte[16];
                ReadExactly(fs, tail, 16);
                string marker = Encoding.ASCII.GetString(tail, 0, 8);
                if (marker != Marker) throw new InvalidDataException("安装包损坏：找不到数据段。");
                payloadLength = BitConverter.ToInt64(tail, 8);
                payloadOffset = fileLength - 16 - payloadLength;
                if (payloadOffset <= 0 || payloadLength <= 0) throw new InvalidDataException("安装包数据段无效。");
            }

            string root = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DesktophelperApp",
                AppVersion + "-" + BuildId);
            string ready = Path.Combine(root, ".ready");
            if (!File.Exists(ready))
            {
                ExtractPayload(self, payloadOffset, payloadLength, root, ready);
            }

            string exe = Path.Combine(root, "${product}.exe");
            if (!File.Exists(exe)) throw new FileNotFoundException("找不到主程序。", exe);
            ProcessStartInfo start = new ProcessStartInfo(exe);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            Process.Start(start);
        }
        catch (Exception ex)
        {
            MessageBox.Show("${product} 启动失败：\\r\\n" + ex.Message, "${product}",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static void ExtractPayload(string self, long offset, long length, string root, string ready)
    {
        string tempRoot = root + ".tmp-" + Guid.NewGuid().ToString("N");
        string tempZip = Path.Combine(Path.GetTempPath(), "${product}-" + Guid.NewGuid().ToString("N") + ".zip");
        try
        {
            Directory.CreateDirectory(tempRoot);
            using (FileStream input = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (FileStream output = new FileStream(tempZip, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                input.Seek(offset, SeekOrigin.Begin);
                CopyRange(input, output, length);
            }
            ZipFile.ExtractToDirectory(tempZip, tempRoot);
            string inner = Path.Combine(tempRoot, PayloadRoot);
            if (!Directory.Exists(inner)) throw new InvalidDataException("压缩包结构不正确。");
            if (Directory.Exists(root))
            {
                try { Directory.Delete(root, true); } catch { }
            }
            Directory.CreateDirectory(Path.GetDirectoryName(root));
            Directory.Move(inner, root);
            File.WriteAllText(ready, DateTime.UtcNow.ToString("o"));
            CleanOlderVersions(root);
        }
        finally
        {
            TryDeleteFile(tempZip);
            TryDeleteDirectory(tempRoot);
        }
    }

    private static void CopyRange(Stream input, Stream output, long length)
    {
        byte[] buffer = new byte[1024 * 1024];
        long remaining = length;
        while (remaining > 0)
        {
            int want = (int)Math.Min(buffer.Length, remaining);
            int read = input.Read(buffer, 0, want);
            if (read <= 0) throw new EndOfStreamException("安装包数据不完整。");
            output.Write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static void ReadExactly(Stream stream, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) throw new EndOfStreamException("安装包尾部不完整。");
            offset += read;
        }
    }

    private static void TryDeleteFile(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); } catch { }
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
    }

    private static void CleanOlderVersions(string currentRoot)
    {
        try
        {
            string parent = Path.GetDirectoryName(currentRoot);
            if (!Directory.Exists(parent)) return;
            foreach (string directory in Directory.GetDirectories(parent))
            {
                if (string.Equals(directory, currentRoot, StringComparison.OrdinalIgnoreCase)) continue;
                string name = Path.GetFileName(directory);
                if (string.Equals(name, AppVersion, StringComparison.OrdinalIgnoreCase)
                    || name.StartsWith(AppVersion + "-", StringComparison.OrdinalIgnoreCase))
                {
                    TryDeleteDirectory(directory);
                }
            }
        }
        catch { }
    }
}
`;
}

async function main() {
  if (!existsSync(zipPath)) {
    const result = spawnSync(process.execPath, [join(root, "scripts", "package.mjs")], {
      cwd: root,
      stdio: "inherit",
    });
    if (result.status !== 0) throw new Error("folder package failed");
  }
  if (!existsSync(csc)) throw new Error("C# compiler not found: " + csc);

  await mkdir(buildDir, { recursive: true });
  const iconPng = await readFile(join(root, "assets", "icon.png"));
  const iconPath = join(buildDir, "icon.ico");
  await writeFile(iconPath, makeIco(iconPng));

  const buildId = (await sha256(zipPath)).slice(0, 12);

  const sourcePath = join(buildDir, "launcher.cs");
  const stubPath = join(buildDir, "launcher.exe");
  await writeFile(sourcePath, launcherSource(buildId), "utf8");

  const compile = spawnSync(
    csc,
    [
      "/nologo",
      "/target:winexe",
      "/platform:anycpu",
      "/optimize+",
      "/win32icon:" + iconPath,
      "/out:" + stubPath,
      "/r:System.dll",
      "/r:System.Windows.Forms.dll",
      "/r:System.IO.Compression.dll",
      "/r:System.IO.Compression.FileSystem.dll",
      "/r:System.IO.Compression.ZipFile.dll",
      sourcePath,
    ],
    { cwd: buildDir, stdio: "inherit" },
  );
  if (compile.status !== 0) throw new Error("launcher compilation failed");

  const stub = await readFile(stubPath);
  const payload = await readFile(zipPath);
  const tail = Buffer.alloc(16);
  tail.write("DHZIP001", 0, "ascii");
  tail.writeBigInt64LE(BigInt(payload.length), 8);
  if (existsSync(portablePath)) await rm(portablePath, { force: true });
  await writeFile(portablePath, Buffer.concat([stub, payload, tail]));

  const portableHash = await sha256(portablePath);
  const zipHash = await sha256(zipPath);
  await writeFile(
    join(root, "dist", "SHA256SUMS.txt"),
    `${zipHash}  ${stageName}.zip\r\n${portableHash}  ${product}-Portable-${version}.exe\r\n`,
    "utf8",
  );

  console.log("");
  console.log("portable exe ready:");
  console.log("  " + portablePath);
  console.log("sha256: " + portableHash);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
