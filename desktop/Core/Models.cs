using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;

namespace NebulaDrop.Core
{
    internal sealed class Device
    {
        internal string Fingerprint, Alias, DeviceModel, DeviceType, Protocol, Version, SeenIp, Via;
        internal int Port;
        internal bool Nebula, Natted, DirectOk;
        internal List<string> Ips;
        internal List<string> Candidates = new List<string>();
        internal long LastSeen;

        internal Dictionary<string, object> Summary() => new Dictionary<string, object>
        {
            ["alias"] = Alias, ["fingerprint"] = Fingerprint, ["deviceType"] = DeviceType ?? "desktop", ["deviceModel"] = DeviceModel,
        };
    }

    /// <summary>一个待发送或待接收文件的元数据（与协议中的 files 条目一致）。</summary>
    internal sealed class FileMeta
    {
        internal string Id, FileName, FileType, Sha256, Preview, Modified, Accessed, Token, LocalPath;
        internal long Size;
        internal byte[] Buffer;

        internal Dictionary<string, object> Wire(bool withToken = false)
        {
            var d = new Dictionary<string, object> { ["id"] = Id, ["fileName"] = FileName, ["size"] = Size, ["fileType"] = FileType };
            if (Preview != null) d["preview"] = Preview;
            if (Modified != null) d["metadata"] = new Dictionary<string, object> { ["modified"] = Modified, ["accessed"] = Accessed };
            if (withToken && Token != null) d["token"] = Token;
            return d;
        }

        internal static FileMeta FromWire(Dictionary<string, object> d)
        {
            if (d == null || string.IsNullOrEmpty(d.Str("id"))) return null;
            var m = d.Obj("metadata");
            return new FileMeta
            {
                Id = d.Str("id"), FileName = d.Str("fileName") ?? "file", Size = d.Long("size"), FileType = d.Str("fileType"),
                Sha256 = d.Str("sha256"), Preview = d.Get("preview") as string, Modified = m.Str("modified"), Token = d.Str("token"),
            };
        }
    }

    internal sealed class TFile
    {
        internal string Id, Name, Status = "pending", Path;
        internal long Size, Done;
    }

    internal sealed class Transfer
    {
        internal string Id, Direction, Mode, Status = "waiting", Error, SaveDir, Text;
        internal Device Peer;
        internal List<TFile> Files = new List<TFile>();
        internal long TotalBytes, DoneBytes, StartedAt, EndedAt, Speed;
        internal List<string> SavedPaths = new List<string>();
        internal long LastBytes, LastTick;
        internal int EmitPending;
        internal CancellationTokenSource Cts = new CancellationTokenSource();
        internal Action OnCancel;

        internal static readonly string[] Final = { "done", "failed", "rejected", "cancelled" };
        internal bool IsFinal => Final.Contains(Status);

        internal void AddDone(long n) => Interlocked.Add(ref DoneBytes, n);

        internal Dictionary<string, object> ToJson()
        {
            var d = new Dictionary<string, object>
            {
                ["id"] = Id, ["direction"] = Direction, ["mode"] = Mode,
                ["peer"] = new Dictionary<string, object> { ["alias"] = Peer.Alias, ["fingerprint"] = Peer.Fingerprint, ["deviceType"] = Peer.DeviceType ?? "desktop" },
                ["status"] = Status,
                ["files"] = Files.Select(f => new Dictionary<string, object>
                {
                    ["id"] = f.Id, ["name"] = f.Name, ["size"] = f.Size, ["done"] = Interlocked.Read(ref f.Done), ["status"] = f.Status, ["path"] = f.Path,
                }).ToList(),
                ["totalBytes"] = TotalBytes, ["doneBytes"] = Interlocked.Read(ref DoneBytes), ["startedAt"] = StartedAt,
                ["endedAt"] = EndedAt == 0 ? (object)null : EndedAt, ["error"] = Error, ["speed"] = Speed,
                ["savedPaths"] = SavedPaths.ToList(), ["saveDir"] = SaveDir,
            };
            if (Text != null) d["text"] = Text; // 界面以是否存在 text 字段区分文字消息
            return d;
        }
    }

    internal sealed class InFile
    {
        internal FileMeta Meta;
        internal string Token, Status = "pending", Path;
    }

    internal sealed class Session
    {
        internal string Id, Ip, Mode, OfferId;
        internal Device Sender;
        internal Dictionary<string, InFile> Files = new Dictionary<string, InFile>();
        internal Transfer Transfer;
        internal long LastActivity;
        internal bool Closed;
        internal readonly List<Stream> Writers = new List<Stream>();
    }

    internal sealed class TunnelIn
    {
        internal readonly List<object> Queue = new List<object>();
        internal System.Threading.Tasks.TaskCompletionSource<bool> Waiter;
        internal long LastPoll;
    }

    internal sealed class TunnelOut
    {
        internal string Base;
        internal volatile bool Stopped;
        internal int Fails;
    }

    internal sealed class Offer
    {
        internal string Id, Fp;
        internal Transfer T;
        internal Dictionary<string, FileMeta> Files = new Dictionary<string, FileMeta>();
        internal System.Threading.Tasks.TaskCompletionSource<bool> Done = new System.Threading.Tasks.TaskCompletionSource<bool>();
        internal bool Accepted;
        internal readonly List<Stream> Streams = new List<Stream>();
        internal Timer AcceptTimer;
    }

    internal sealed class SendError : Exception
    {
        internal string Code;
        internal SendError(string msg, string code = null) : base(msg) { Code = code; }
    }

    internal sealed class Decision
    {
        internal bool Accept;
        internal List<string> FileIds;
    }
}
