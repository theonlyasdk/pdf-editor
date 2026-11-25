use parking_lot::Mutex;
use pdf_core::renderer::{PdfRenderer, RawBitmap};
use std::io::{BufReader, BufWriter, Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

const OP_SET_DOC: u8 = 1;
const OP_RENDER_RGBA: u8 = 2;
const OP_SHUTDOWN: u8 = 3;

const RESP_OK: u8 = 0;
const RESP_ERR: u8 = 1;
const RESP_NEED_DOC: u8 = 2;

#[cfg(windows)]
mod win_job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectBasicLimitInformation {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    #[derive(Default)]
    struct JobObjectExtendedLimitInformation {
        basic_limit_information: JobObjectBasicLimitInformation,
        io_info: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(lp_job_attributes: *const c_void, lp_name: *const u16) -> isize;
        fn SetInformationJobObject(
            h_job: isize,
            job_object_information_class: u32,
            lp_job_object_information: *const c_void,
            cb_job_object_information_length: u32,
        ) -> i32;
        fn AssignProcessToJobObject(h_job: isize, h_process: isize) -> i32;
        fn CloseHandle(h_object: isize) -> i32;
    }

    pub struct JobHandle(isize);

    impl JobHandle {
        pub fn new() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle == 0 {
                    return None;
                }
                let mut info = JobObjectExtendedLimitInformation::default();
                info.basic_limit_information.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
                    (&raw const info).cast(),
                    std::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self(handle))
            }
        }

        pub fn assign(&self, child: &Child) {
            unsafe {
                let _ = AssignProcessToJobObject(self.0, child.as_raw_handle() as isize);
            }
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                if self.0 != 0 {
                    CloseHandle(self.0);
                    self.0 = 0;
                }
            }
        }
    }
}

struct WorkerSlot {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    loaded_source_id: u64,
    dead: bool,
}

impl WorkerSlot {
    fn spawn(exe: &std::path::Path) -> Result<Self, String> {
        let mut cmd = Command::new(exe);
        cmd.arg("--render-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("Missing worker stdin")?;
        let stdout = child.stdout.take().ok_or("Missing worker stdout")?;

        Ok(Self {
            child,
            stdin: BufWriter::new(stdin),
            stdout: BufReader::new(stdout),
            loaded_source_id: 0,
            dead: false,
        })
    }

    fn send_doc(&mut self, source_id: u64, bytes: &[u8]) -> Result<(), String> {
        self.stdin
            .write_all(&[OP_SET_DOC])
            .and_then(|_| self.stdin.write_all(&source_id.to_le_bytes()))
            .and_then(|_| self.stdin.write_all(&(bytes.len() as u64).to_le_bytes()))
            .and_then(|_| self.stdin.write_all(bytes))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| {
                self.dead = true;
                e.to_string()
            })?;

        let mut status = [0u8; 1];
        self.stdout.read_exact(&mut status).map_err(|e| {
            self.dead = true;
            e.to_string()
        })?;

        if status[0] == RESP_OK {
            self.loaded_source_id = source_id;
            Ok(())
        } else {
            Err(read_error(&mut self.stdout))
        }
    }

    fn render_rgba(
        &mut self,
        source_id: u64,
        bytes: &[u8],
        page_index: usize,
        target_width: u32,
    ) -> Result<RawBitmap, String> {
        if self.dead {
            return Err("Worker process closed".into());
        }
        if self.loaded_source_id != source_id {
            self.send_doc(source_id, bytes)?;
        }

        for attempt in 0..2 {
            self.stdin
                .write_all(&[OP_RENDER_RGBA])
                .and_then(|_| self.stdin.write_all(&source_id.to_le_bytes()))
                .and_then(|_| self.stdin.write_all(&(page_index as u32).to_le_bytes()))
                .and_then(|_| self.stdin.write_all(&target_width.to_le_bytes()))
                .and_then(|_| self.stdin.flush())
                .map_err(|e| {
                    self.dead = true;
                    e.to_string()
                })?;

            let mut status = [0u8; 1];
            self.stdout.read_exact(&mut status).map_err(|e| {
                self.dead = true;
                e.to_string()
            })?;

            match status[0] {
                RESP_OK => {
                    let mut header = [0u8; 16];
                    self.stdout.read_exact(&mut header).map_err(|e| {
                        self.dead = true;
                        e.to_string()
                    })?;
                    let width = u32::from_le_bytes(header[0..4].try_into().unwrap());
                    let height = u32::from_le_bytes(header[4..8].try_into().unwrap());
                    let rgba_len = u64::from_le_bytes(header[8..16].try_into().unwrap()) as usize;
                    let mut frame = Vec::with_capacity(8 + rgba_len);
                    frame.extend_from_slice(&header[0..8]);
                    frame.resize(8 + rgba_len, 0);
                    self.stdout.read_exact(&mut frame[8..]).map_err(|e| {
                        self.dead = true;
                        e.to_string()
                    })?;
                    return Ok(RawBitmap::from_frame(width, height, frame));
                }
                RESP_NEED_DOC if attempt == 0 => {
                    self.send_doc(source_id, bytes)?;
                }
                _ => return Err(read_error(&mut self.stdout)),
            }
        }

        Err("Worker failed to load document".into())
    }

    fn shutdown(&mut self) {
        if !self.dead {
            let _ = self.stdin.write_all(&[OP_SHUTDOWN]);
            let _ = self.stdin.flush();
            self.dead = true;
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_error(stdout: &mut BufReader<ChildStdout>) -> String {
    let mut len_buf = [0u8; 4];
    if stdout.read_exact(&mut len_buf).is_err() {
        return "Worker error".into();
    }
    let len = (u32::from_le_bytes(len_buf) as usize).min(64 * 1024);
    let mut msg = vec![0u8; len];
    if stdout.read_exact(&mut msg).is_err() {
        return "Worker error".into();
    }
    String::from_utf8_lossy(&msg).into_owned()
}

pub struct RenderWorkerPool {
    workers: Vec<Mutex<WorkerSlot>>,
    next_idx: AtomicUsize,
    #[cfg(windows)]
    _job: Option<win_job::JobHandle>,
}

impl RenderWorkerPool {
    pub fn spawn_default() -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let count = std::thread::available_parallelism()
            .map(|n| n.get().clamp(2, 4))
            .unwrap_or(2);

        #[cfg(windows)]
        let job = win_job::JobHandle::new();

        let mut workers = Vec::with_capacity(count);
        for _ in 0..count {
            let slot = WorkerSlot::spawn(&exe).ok()?;
            #[cfg(windows)]
            if let Some(ref j) = job {
                j.assign(&slot.child);
            }
            workers.push(Mutex::new(slot));
        }

        Some(Self {
            workers,
            next_idx: AtomicUsize::new(0),
            #[cfg(windows)]
            _job: job,
        })
    }

    pub fn render_page_rgba(
        &self,
        source_id: u64,
        bytes: &[u8],
        page_index: usize,
        target_width: u32,
    ) -> Result<RawBitmap, String> {
        if self.workers.is_empty() {
            return Err("No render workers available".into());
        }

        let start = self.next_idx.fetch_add(1, Ordering::Relaxed) % self.workers.len();
        for offset in 0..self.workers.len() {
            let idx = (start + offset) % self.workers.len();
            if let Some(mut slot) = self.workers[idx].try_lock() {
                if !slot.dead {
                    return slot.render_rgba(source_id, bytes, page_index, target_width);
                }
            }
        }

        let mut slot = self.workers[start].lock();
        slot.render_rgba(source_id, bytes, page_index, target_width)
    }

    pub fn shutdown(&self) {
        for worker in &self.workers {
            worker.lock().shutdown();
        }
    }
}

impl Drop for RenderWorkerPool {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn write_err(out: &mut impl Write, msg: &str) -> std::io::Result<()> {
    let bytes = msg.as_bytes();
    let len = bytes.len().min(64 * 1024) as u32;
    out.write_all(&[RESP_ERR])?;
    out.write_all(&len.to_le_bytes())?;
    out.write_all(&bytes[..len as usize])?;
    out.flush()
}

pub fn run_render_worker() {
    let renderer = match PdfRenderer::new() {
        Ok(r) => r,
        Err(_) => return,
    };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());

    let mut current_doc: Option<(u64, Arc<Vec<u8>>)> = None;
    let mut op = [0u8; 1];

    while reader.read_exact(&mut op).is_ok() {
        match op[0] {
            OP_SET_DOC => {
                let mut hdr = [0u8; 16];
                if reader.read_exact(&mut hdr).is_err() {
                    break;
                }
                let source_id = u64::from_le_bytes(hdr[0..8].try_into().unwrap());
                let len = u64::from_le_bytes(hdr[8..16].try_into().unwrap()) as usize;
                let mut bytes = vec![0u8; len];
                if reader.read_exact(&mut bytes).is_err() {
                    break;
                }
                current_doc = Some((source_id, Arc::new(bytes)));
                if writer.write_all(&[RESP_OK]).is_err() || writer.flush().is_err() {
                    break;
                }
            }
            OP_RENDER_RGBA => {
                let mut hdr = [0u8; 16];
                if reader.read_exact(&mut hdr).is_err() {
                    break;
                }
                let source_id = u64::from_le_bytes(hdr[0..8].try_into().unwrap());
                let page_index = u32::from_le_bytes(hdr[8..12].try_into().unwrap()) as usize;
                let target_width = u32::from_le_bytes(hdr[12..16].try_into().unwrap());

                let Some((loaded_id, ref bytes)) = current_doc else {
                    if writer.write_all(&[RESP_NEED_DOC]).is_err() || writer.flush().is_err() {
                        break;
                    }
                    continue;
                };
                if loaded_id != source_id {
                    if writer.write_all(&[RESP_NEED_DOC]).is_err() || writer.flush().is_err() {
                        break;
                    }
                    continue;
                }

                match renderer.render_page_rgba_vec_for_source(
                    source_id,
                    Arc::clone(bytes),
                    page_index,
                    target_width,
                    None,
                ) {
                    Ok((width, height, rgba)) => {
                        let ok = writer.write_all(&[RESP_OK])
                            .and_then(|_| writer.write_all(&width.to_le_bytes()))
                            .and_then(|_| writer.write_all(&height.to_le_bytes()))
                            .and_then(|_| writer.write_all(&(rgba.len() as u64).to_le_bytes()))
                            .and_then(|_| writer.write_all(&rgba))
                            .and_then(|_| writer.flush());
                        if ok.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        if write_err(&mut writer, &e.to_string()).is_err() {
                            break;
                        }
                    }
                }
            }
            OP_SHUTDOWN => break,
            _ => break,
        }
    }
}
