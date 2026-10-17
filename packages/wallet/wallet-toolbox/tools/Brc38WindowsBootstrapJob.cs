// Maintainer bootstrap controller, compiled only by Windows PowerShell/.NET.
// This Job owns the original Node process and every normal compiler descendant.
// It is resource/process isolation, not a token, network or VM security boundary.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class Brc38WindowsBootstrapJob
{
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IOCounts
    {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IOCounts IO;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup
    {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out ExtendedLimits limits, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessAffinityMask(IntPtr process, out UIntPtr processMask, out UIntPtr systemMask);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inherit, uint flags, string environment, string directory,
        ref Startup startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    public sealed class Result
    {
        public uint WorkerPID, WorkerExitCode, TotalProcesses;
        public ulong MemoryLimitBytes = 12884901888, PeakJobMemoryBytes;
        public string AffinityMaskHex;
        public uint ProcessLimit = 512, MaximumCPUCount = 4, DeadlineMilliseconds = 600000;
        public bool AssignedBeforeResume, LimitsReadBack, NonInheritedJobHandle;
        public bool DeadlineExpired, WorkerExitObserved, ZeroActiveProcessesObserved, AllHandlesClosed;
        public bool OriginalProcessWorkerStopped, VMShutdownObserved = false, Qualified = false, Success;
        public string[] Errors;
    }
    static bool retained;
    static void Check(bool value, string operation)
    {
        if (!value) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }
    // Windows CRT argv quoting: trailing backslashes are doubled before a quote.
    static string Quote(string value)
    {
        if (value == null || value.IndexOf('\0') >= 0 || value.Length > 8192)
            throw new ArgumentException("Bootstrap argument differs");
        StringBuilder text = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', c == '"' ? slashes * 2 + 1 : slashes);
            text.Append(c); slashes = 0;
        }
        text.Append('\\', slashes * 2); text.Append('"'); return text.ToString();
    }
    static ulong SelectAffinity()
    {
        UIntPtr process, system;
        Check(GetProcessAffinityMask(GetCurrentProcess(), out process, out system), "GetProcessAffinityMask");
        ulong available = process.ToUInt64() & system.ToUInt64(), selected = 0; int count = 0;
        for (int i = 0; i < 64 && count < 4; i++)
            if ((available & (1UL << i)) != 0) { selected |= 1UL << i; count++; }
        if (count == 0) throw new InvalidOperationException("Bootstrap CPU affinity unavailable");
        return selected;
    }
    static ExtendedLimits Limits(IntPtr job)
    {
        ExtendedLimits actual;
        Check(QueryInformationJobObject(job, 9, out actual, (uint)Marshal.SizeOf(typeof(ExtendedLimits)), IntPtr.Zero),
            "Read Job extended limits");
        return actual;
    }
    static Accounting State(IntPtr job)
    {
        Accounting actual;
        Check(QueryInformationJobObject(job, 1, out actual, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero),
            "Read Job active processes");
        return actual;
    }
    static void DisposeHandle(ref IntPtr handle, List<string> errors)
    {
        if (handle == IntPtr.Zero) return;
        if (CloseHandle(handle)) { handle = IntPtr.Zero; return; }
        errors.Add("Original native handle close failed: " + Marshal.GetLastWin32Error());
        // Retry the SAME original handle; a new object is never substituted.
        if (CloseHandle(handle)) handle = IntPtr.Zero;
    }
    public static Result Run(string node, string worker, string options, string directory, string systemRoot)
    {
        if (retained || IntPtr.Size != 8 || Environment.OSVersion.Platform != PlatformID.Win32NT)
            throw new InvalidOperationException("Bootstrap requires its original Windows64 controller");
        Result result = new Result(); List<string> errors = new List<string>();
        IntPtr job = IntPtr.Zero; ProcessInfo child = new ProcessInfo(); bool attached = false;
        Stopwatch clock = Stopwatch.StartNew();
        try
        {
            ulong affinity = SelectAffinity(); result.AffinityMaskHex = affinity.ToString("x16");
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "Create original Job");
            uint handleFlags;
            Check(SetHandleInformation(job, 1, 0) && GetHandleInformation(job, out handleFlags) && (handleFlags & 1) == 0,
                "Exclude Job handle inheritance");
            result.NonInheritedJobHandle = true;
            ExtendedLimits requested = new ExtendedLimits();
            // No BREAKAWAY/SILENT_BREAKAWAY; all normal compiler children stay.
            requested.Basic.Flags = 0x2000 | 0x400 | 0x200 | 0x8 | 0x10;
            requested.Basic.ActiveProcessLimit = result.ProcessLimit;
            requested.Basic.Affinity = new UIntPtr(affinity);
            requested.JobMemory = new UIntPtr(result.MemoryLimitBytes);
            Check(SetInformationJobObject(job, 9, ref requested, (uint)Marshal.SizeOf(typeof(ExtendedLimits))), "Set Job limits");
            ExtendedLimits actual = Limits(job);
            Check(actual.Basic.Flags == requested.Basic.Flags && actual.JobMemory == requested.JobMemory &&
                actual.Basic.ActiveProcessLimit == requested.Basic.ActiveProcessLimit && actual.Basic.Affinity == requested.Basic.Affinity,
                "Job limits differ before launch");
            result.LimitsReadBack = true;
            string command = Quote(node) + " --max-old-space-size=1536 " + Quote(worker) + " " + Quote(options);
            if (command.Length >= 32767) throw new ArgumentException("Bootstrap command exceeds Windows extent");
            // Explicit sorted environment; no inherited NODE_OPTIONS or compiler flags.
            string environment = "SystemRoot=" + systemRoot + '\0' + "TEMP=" + directory + '\0' + "TMP=" + directory + "\0\0";
            Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
            Check(CreateProcess(node, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false,
                0x4 | 0x400 | 0x8000000, environment, directory, ref startup, out child), "Create suspended original Node worker");
            result.WorkerPID = child.ProcessId;
            Check(AssignProcessToJobObject(job, child.Process), "Assign suspended original Node worker"); attached = true;
            bool member;
            Check(IsProcessInJob(child.Process, job, out member) && member, "Read original worker Job membership");
            actual = Limits(job);
            Check(actual.Basic.Flags == requested.Basic.Flags && actual.JobMemory == requested.JobMemory &&
                actual.Basic.ActiveProcessLimit == requested.Basic.ActiveProcessLimit && actual.Basic.Affinity == requested.Basic.Affinity,
                "Job limits differ after attachment");
            result.AssignedBeforeResume = true;
            Check(ResumeThread(child.Thread) == 1, "Resume original worker exactly once");
            while (true)
            {
                uint status = WaitForSingleObject(child.Process, 50);
                if (status == 0) { result.WorkerExitObserved = true; break; }
                if (status != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "Wait original worker");
                if (clock.ElapsedMilliseconds >= result.DeadlineMilliseconds)
                {
                    result.DeadlineExpired = true; errors.Add("Original worker exceeded monotonic deadline"); break;
                }
            }
        }
        catch (Exception cause) { errors.Add(cause.Message); }
        finally
        {
            // Always shut down the actual remaining tree, even after Node exit0.
            try
            {
                if (child.Process != IntPtr.Zero)
                {
                    Check(attached ? TerminateJobObject(job, 70) : TerminateProcess(child.Process, 70), "Terminate original worker tree");
                    Stopwatch drain = Stopwatch.StartNew();
                    while (drain.ElapsedMilliseconds < 10000)
                    {
                        result.WorkerExitObserved = WaitForSingleObject(child.Process, 0) == 0;
                        if (attached)
                        {
                            Accounting state = State(job); result.TotalProcesses = state.TotalProcesses;
                            result.ZeroActiveProcessesObserved = state.ActiveProcesses == 0;
                        }
                        if (result.WorkerExitObserved && (!attached || result.ZeroActiveProcessesObserved)) break;
                        Thread.Sleep(10);
                    }
                    Check(result.WorkerExitObserved && (!attached || result.ZeroActiveProcessesObserved), "Original tree still retained");
                    Check(GetExitCodeProcess(child.Process, out result.WorkerExitCode), "Read actual original worker exit");
                }
                if (job != IntPtr.Zero) result.PeakJobMemoryBytes = Limits(job).PeakJobMemory.ToUInt64();
            }
            catch (Exception cause) { errors.Add(cause.Message); }
            DisposeHandle(ref child.Thread, errors); DisposeHandle(ref child.Process, errors); DisposeHandle(ref job, errors);
            result.AllHandlesClosed = child.Thread == IntPtr.Zero && child.Process == IntPtr.Zero && job == IntPtr.Zero;
            result.OriginalProcessWorkerStopped = attached && result.WorkerExitObserved && result.ZeroActiveProcessesObserved && result.AllHandlesClosed;
            retained = !result.AllHandlesClosed || (result.WorkerPID != 0 && !result.WorkerExitObserved) ||
                (attached && !result.OriginalProcessWorkerStopped);
            result.Errors = errors.ToArray();
            result.Success = result.OriginalProcessWorkerStopped && result.AssignedBeforeResume && result.LimitsReadBack &&
                result.NonInheritedJobHandle && !result.DeadlineExpired && result.WorkerExitCode == 0 && errors.Count == 0;
        }
        return result;
    }
}
