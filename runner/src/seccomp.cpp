#include "arena/seccomp.hpp"

#if defined(__linux__)
#include <cerrno>
#include <cstddef>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <array>
#include <vector>

namespace arena::runner {
namespace {

#if defined(__x86_64__)
constexpr unsigned int kNativeAuditArch = AUDIT_ARCH_X86_64;
#elif defined(__aarch64__)
constexpr unsigned int kNativeAuditArch = AUDIT_ARCH_AARCH64;
#else
constexpr unsigned int kNativeAuditArch = 0;
#endif

constexpr std::array<int, 71> kBlockedSyscalls{
    SYS_open,
    SYS_openat,
    SYS_openat2,
    SYS_creat,
    SYS_socket,
    SYS_socketpair,
    SYS_connect,
    SYS_bind,
    SYS_listen,
    SYS_accept,
    SYS_accept4,
    SYS_sendto,
    SYS_sendmsg,
    SYS_sendmmsg,
    SYS_recvfrom,
    SYS_recvmsg,
    SYS_recvmmsg,
    SYS_getsockname,
    SYS_getpeername,
    SYS_setsockopt,
    SYS_getsockopt,
    SYS_shutdown,
    SYS_clone,
    SYS_clone3,
    SYS_fork,
    SYS_vfork,
    SYS_execve,
    SYS_execveat,
    SYS_ptrace,
    SYS_kill,
    SYS_tkill,
    SYS_tgkill,
    SYS_rt_sigaction,
    SYS_rt_sigprocmask,
    SYS_prctl,
    SYS_setrlimit,
    SYS_prlimit64,
    SYS_mount,
    SYS_umount2,
    SYS_pivot_root,
    SYS_chroot,
    SYS_setns,
    SYS_unshare,
    SYS_bpf,
    SYS_perf_event_open,
    SYS_userfaultfd,
    SYS_io_uring_setup,
    SYS_keyctl,
    SYS_add_key,
    SYS_request_key,
    SYS_reboot,
    SYS_kexec_load,
    SYS_init_module,
    SYS_finit_module,
    SYS_delete_module,
    SYS_swapon,
    SYS_swapoff,
    SYS_unlink,
    SYS_unlinkat,
    SYS_rename,
    SYS_renameat,
    SYS_renameat2,
    SYS_mkdir,
    SYS_mkdirat,
    SYS_rmdir,
    SYS_link,
    SYS_linkat,
    SYS_symlink,
    SYS_symlinkat,
    SYS_mknod,
    SYS_mknodat,
};

} // namespace

bool install_algorithm_seccomp() {
    if (kNativeAuditArch == 0) {
        return false;
    }

    std::vector<sock_filter> instructions;
    instructions.reserve(4 + kBlockedSyscalls.size() * 2);
    instructions.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                                    static_cast<unsigned int>(offsetof(seccomp_data, arch))));
    instructions.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, kNativeAuditArch, 1, 0));
    instructions.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));
    instructions.push_back(BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
                                    static_cast<unsigned int>(offsetof(seccomp_data, nr))));

    for (const int syscall_number : kBlockedSyscalls) {
        instructions.push_back(BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K,
                                        static_cast<unsigned int>(syscall_number), 0, 1));
        instructions.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
    }
    instructions.push_back(BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

    struct sock_fprog program{
        static_cast<unsigned short>(instructions.size()),
        instructions.data(),
    };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
        return false;
    }
    return prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program, 0, 0) == 0;
}

} // namespace arena::runner
#else

namespace arena::runner {

bool install_algorithm_seccomp() {
    return false;
}

} // namespace arena::runner
#endif
