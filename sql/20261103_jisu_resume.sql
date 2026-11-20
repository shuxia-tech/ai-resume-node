-- 极速海投简历工作区。一份账号一行，content 保存整份表单 JSON。
-- 服务首次读写时也会 CREATE TABLE IF NOT EXISTS。
CREATE TABLE IF NOT EXISTS `t_jisu_resume` (
  `id` varchar(64) NOT NULL COMMENT '主键',
  `user_id` varchar(64) NOT NULL COMMENT 'C端用户',
  `content` longtext NOT NULL COMMENT '简历工作区JSON',
  `delete_flag` varchar(32) NOT NULL DEFAULT 'NOT_DELETE' COMMENT '删除标识',
  `create_time` datetime DEFAULT NULL COMMENT '创建时间',
  `update_time` datetime DEFAULT NULL COMMENT '更新时间',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_jisu_resume_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='极速海投简历';
