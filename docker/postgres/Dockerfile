FROM postgres:17

# 替换为国内镜像源，避免外部网络不稳定
RUN rm -f /etc/apt/sources.list.d/pgdg.list \
    && sed -i 's/deb.debian.org/mirrors.ustc.edu.cn/g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends --allow-downgrades \
        libpq5=17.11-0+deb13u1 \
        libpq-dev \
        postgresql-server-dev-17 \
        postgresql-17-pgvector \
        ca-certificates \
        git \
        cmake \
        g++ \
        make \
    && git clone --depth 1 https://github.com/jaiminpan/pg_jieba.git /tmp/pg_jieba \
    && cd /tmp/pg_jieba \
    && git submodule update --init --recursive \
    && mkdir build \
    && cd build \
    && cmake -DPostgreSQL_TYPE_INCLUDE_DIR=/usr/include/postgresql/17/server .. \
    && make \
    && make install \
    && rm -rf /tmp/pg_jieba \
    && apt-get purge -y git cmake g++ make \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
