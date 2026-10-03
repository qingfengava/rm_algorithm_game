cmake_minimum_required(VERSION 3.22)

project(arena LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

option(ARENA_BUILD_TESTS "Build C++ tests" ON)

add_library(arena_engine INTERFACE)

target_include_directories(arena_engine
    INTERFACE
        ${CMAKE_CURRENT_SOURCE_DIR}/engine/include
        ${CMAKE_CURRENT_SOURCE_DIR}/sdk/include
)

target_compile_features(arena_engine INTERFACE cxx_std_23)

if(ARENA_BUILD_TESTS)
    enable_testing()

    add_executable(arena_stage1_smoke
        tests/cpp/stage1_smoke.cpp
    )

    target_link_libraries(arena_stage1_smoke PRIVATE arena_engine)
    target_include_directories(arena_stage1_smoke PRIVATE sdk/include)
    add_test(NAME arena_stage1_smoke COMMAND arena_stage1_smoke)
endif()
