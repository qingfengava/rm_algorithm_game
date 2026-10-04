cmake_minimum_required(VERSION 3.22)

project(arena LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(ARENA_BUILD_TESTS "Build C++ tests" ON)
option(ARENA_BUILD_RUNNER "Build official runner and example bot" ON)

add_library(arena_engine STATIC
    engine/src/engine.cpp
)

target_include_directories(arena_engine
    PUBLIC
        ${CMAKE_CURRENT_SOURCE_DIR}/engine/include
        ${CMAKE_CURRENT_SOURCE_DIR}/sdk/include
)

target_compile_features(arena_engine PUBLIC cxx_std_23)

if(ARENA_BUILD_RUNNER)
    add_library(arena_runner_protocol STATIC
        runner/src/protocol.cpp
    )
    target_include_directories(arena_runner_protocol
        PUBLIC
            ${CMAKE_CURRENT_SOURCE_DIR}/runner/include
            ${CMAKE_CURRENT_SOURCE_DIR}/sdk/include
    )
    target_compile_features(arena_runner_protocol PUBLIC cxx_std_23)

    add_executable(arena_example_runner
        runner/src/main.cpp
        examples/example_bot.cpp
    )
    target_link_libraries(arena_example_runner PRIVATE arena_runner_protocol)
    target_include_directories(arena_example_runner PRIVATE sdk/include examples)
    target_compile_features(arena_example_runner PRIVATE cxx_std_23)

    add_executable(arena_baseline_runner
        runner/src/main.cpp
        examples/baseline_bot.cpp
    )
    target_link_libraries(arena_baseline_runner PRIVATE arena_runner_protocol)
    target_include_directories(arena_baseline_runner PRIVATE sdk/include examples)
    target_compile_features(arena_baseline_runner PRIVATE cxx_std_23)

    add_executable(arena_match_demo
        runner/src/match_demo.cpp
    )
    target_link_libraries(arena_match_demo PRIVATE arena_engine arena_runner_protocol)
    target_include_directories(arena_match_demo PRIVATE sdk/include engine/include runner/include)
    target_compile_features(arena_match_demo PRIVATE cxx_std_23)
endif()

if(ARENA_BUILD_TESTS)
    enable_testing()

    add_executable(arena_stage1_smoke
        tests/cpp/stage1_smoke.cpp
    )

    target_link_libraries(arena_stage1_smoke PRIVATE arena_engine)
    target_include_directories(arena_stage1_smoke PRIVATE sdk/include)
    add_test(NAME arena_stage1_smoke COMMAND arena_stage1_smoke)

    add_executable(arena_engine_tests
        tests/cpp/engine_tests.cpp
    )

    target_link_libraries(arena_engine_tests PRIVATE arena_engine)
    target_include_directories(arena_engine_tests PRIVATE sdk/include)
    add_test(NAME arena_engine_tests COMMAND arena_engine_tests)

    if(ARENA_BUILD_RUNNER)
        add_executable(arena_runner_protocol_tests
            tests/cpp/runner_protocol_tests.cpp
        )
        target_link_libraries(arena_runner_protocol_tests PRIVATE arena_runner_protocol)
        target_include_directories(arena_runner_protocol_tests PRIVATE sdk/include runner/include)
        target_compile_features(arena_runner_protocol_tests PRIVATE cxx_std_23)
        add_test(NAME arena_runner_protocol_tests COMMAND arena_runner_protocol_tests)
        add_test(NAME arena_example_runner_self_test COMMAND arena_example_runner --self-test)
        add_test(NAME arena_match_demo
            COMMAND arena_match_demo $<TARGET_FILE:arena_example_runner>)
    endif()
endif()
